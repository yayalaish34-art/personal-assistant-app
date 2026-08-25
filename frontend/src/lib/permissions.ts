import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

/**
 * The two permissions this app needs, asked in one place.
 *
 * Both used to be requested at the moment they were first needed: the
 * microphone when a voice session opened, notifications when the first
 * reminder was scheduled. That is the worst possible moment. The system prompt
 * arrives mid-sentence with nothing on screen explaining what it is for, and a
 * refusal there is close to permanent — iOS never asks a second time, and
 * Android stops asking after the second no. Onboarding asks instead, where
 * there is room for a sentence about why each one is wanted.
 *
 * Nothing here throws and nothing here is required. A refusal comes back as
 * 'denied' and the app carries on without that capability: she can still be
 * typed to without a microphone, and tasks still save without reminders.
 */

export type PermissionState =
  /** Granted, now or on an earlier launch. */
  | 'granted'
  /** Not granted — refused, or never asked and still askable. */
  | 'denied'
  /** Nothing to ask. No recorder on this platform, or the module is missing. */
  | 'unavailable';

/** Android drops any notification posted to a channel that does not exist. */
export const REMINDER_CHANNEL = 'reminders';

// ── Microphone ──────────────────────────────────────────────────────────────

interface AudioPermissionApi {
  getRecordingPermissionsAsync?: () => Promise<{ granted: boolean }>;
  requestRecordingPermissionsAsync?: () => Promise<{ granted: boolean }>;
}

let cachedAudio: AudioPermissionApi | null | undefined;

/**
 * `expo-audio`, loaded the same guarded way the voice session loads it.
 *
 * On web and in any build without the native module the require throws rather
 * than resolving to a stub, and an onboarding step is not worth a crash. The
 * permission calls hang off `AudioModule` as well as the package root; the
 * former is the path the voice session already uses and is known to work, so
 * it is tried first.
 */
function audioApi(): AudioPermissionApi | null {
  if (cachedAudio === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('expo-audio') as { AudioModule?: AudioPermissionApi } & AudioPermissionApi;
      cachedAudio = mod.AudioModule ?? mod ?? null;
    } catch {
      cachedAudio = null;
    }
  }
  return cachedAudio ?? null;
}

/** Whether the microphone is already ours, without prompting for it. */
export async function getMicrophoneState(): Promise<PermissionState> {
  const audio = audioApi();
  if (!audio?.getRecordingPermissionsAsync) return 'unavailable';
  try {
    const { granted } = await audio.getRecordingPermissionsAsync();
    return granted ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Prompts for the microphone. Safe to call when it is already granted. */
export async function requestMicrophone(): Promise<PermissionState> {
  const audio = audioApi();
  if (!audio?.requestRecordingPermissionsAsync) return 'unavailable';
  try {
    const { granted } = await audio.requestRecordingPermissionsAsync();
    return granted ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

// ── Notifications ───────────────────────────────────────────────────────────

/**
 * Creates the reminder channel on Android.
 *
 * Unconditional, and deliberately not folded into the permission request:
 * channel creation used to sit after the request and behind an early return
 * for permission that was already granted, so on every launch *after* the
 * first the channel was never made — and a notification scheduled against a
 * channel id that does not exist is dropped by the system without a word.
 * Creating a channel that already exists is a no-op, so calling this often
 * costs nothing.
 */
export async function ensureReminderChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
      name: 'Reminders',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
    });
  } catch {
    /* without a channel the reminder is lost, but the row is still saved */
  }
}

/** Whether reminders may be posted, without prompting. */
export async function getNotificationState(): Promise<PermissionState> {
  try {
    const current = await Notifications.getPermissionsAsync();
    return current.granted ? 'granted' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/**
 * Prompts for notifications, and makes sure the Android channel exists.
 *
 * `canAskAgain` being false is not an error to report: the answer is already
 * no and the system will not show a prompt, so there is nothing to do but say
 * 'denied' and let the caller carry on.
 */
export async function requestNotifications(): Promise<PermissionState> {
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) {
      await ensureReminderChannel();
      return 'granted';
    }
    if (!current.canAskAgain) return 'denied';

    // A banner and a sound, and no badge: an unread count on the icon is not
    // something this app ever sets, so asking for it would be asking for a
    // permission it has no use for.
    const asked = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowSound: true, allowBadge: false },
    });
    if (!asked.granted) return 'denied';

    await ensureReminderChannel();
    return 'granted';
  } catch {
    return 'unavailable';
  }
}
