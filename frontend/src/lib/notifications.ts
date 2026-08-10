import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { t } from './i18n';

// Reminders, scheduled on the device.
//
// Nothing is sent from a server: the data lives on this phone, so the alarms
// do too. Each task or event owns at most one scheduled notification, and the
// id of that notification is kept alongside the row's own id so it can be
// cancelled when the row moves, completes or is deleted — otherwise a deleted
// meeting still rings.

const HANDLE_KEY = '@pa/notificationIds';

/** row id → scheduled notification id. */
type Handles = Record<string, string>;

let configured = false;

/** Foreground notifications are silent unless the app says otherwise. */
function configureOnce(): void {
  if (configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

async function readHandles(): Promise<Handles> {
  try {
    const raw = await AsyncStorage.getItem(HANDLE_KEY);
    return raw ? (JSON.parse(raw) as Handles) : {};
  } catch {
    return {};
  }
}

async function writeHandles(handles: Handles): Promise<void> {
  try {
    await AsyncStorage.setItem(HANDLE_KEY, JSON.stringify(handles));
  } catch {
    /* a lost handle only means one stale reminder */
  }
}

/**
 * Asks once, the first time something is actually scheduled.
 *
 * Returns false when the user said no, in which case scheduling quietly does
 * nothing — a refused permission is not an error worth interrupting a
 * conversation for.
 */
async function ensurePermission(): Promise<boolean> {
  configureOnce();
  try {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    if (!current.canAskAgain) return false;
    const asked = await Notifications.requestPermissionsAsync();
    if (!asked.granted) return false;

    if (Platform.OS === 'android') {
      // Android 8+ drops notifications that arrive without a channel.
      await Notifications.setNotificationChannelAsync('reminders', {
        name: 'Reminders',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
      });
    }
    return true;
  } catch {
    return false;
  }
}

/** Drops the reminder belonging to a row, if it has one. */
export async function cancelReminder(rowId: string): Promise<void> {
  const handles = await readHandles();
  const handle = handles[rowId];
  if (!handle) return;
  try {
    await Notifications.cancelScheduledNotificationAsync(handle);
  } catch {
    /* already fired or already gone */
  }
  delete handles[rowId];
  await writeHandles(handles);
}

/**
 * Schedules one reminder for a row, replacing any it already had.
 *
 * A time in the past schedules nothing — it would fire immediately, which
 * reads as a bug rather than a reminder.
 */
export async function scheduleReminder(input: {
  rowId: string;
  title: string;
  body?: string;
  /** When it should fire. */
  at: Date;
}): Promise<void> {
  await cancelReminder(input.rowId);

  if (Number.isNaN(input.at.getTime()) || input.at.getTime() <= Date.now()) return;
  if (!(await ensurePermission())) return;

  try {
    const handle = await Notifications.scheduleNotificationAsync({
      content: {
        title: input.title,
        ...(input.body ? { body: input.body } : {}),
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: input.at,
        ...(Platform.OS === 'android' ? { channelId: 'reminders' } : {}),
      },
    });
    const handles = await readHandles();
    handles[input.rowId] = handle;
    await writeHandles(handles);
  } catch {
    /* scheduling is best-effort; the row is saved either way */
  }
}

/** A task rings when it is due. */
export async function scheduleTaskReminder(task: {
  id: string;
  title: string;
  dueAt: string | null;
  isDone?: boolean;
}): Promise<void> {
  if (!task.dueAt || task.isDone) {
    await cancelReminder(task.id);
    return;
  }
  await scheduleReminder({
    rowId: task.id,
    title: t('notify.taskTitle'),
    body: task.title,
    at: new Date(task.dueAt),
  });
}

/** An event rings `reminderMinutesBefore` ahead of its start. */
export async function scheduleEventReminder(event: {
  id: string;
  title: string;
  startsAt: string;
  reminderMinutesBefore: number | null;
}): Promise<void> {
  if (event.reminderMinutesBefore === null || event.reminderMinutesBefore === undefined) {
    await cancelReminder(event.id);
    return;
  }
  const starts = new Date(event.startsAt).getTime();
  if (Number.isNaN(starts)) return;

  await scheduleReminder({
    rowId: event.id,
    title: t('notify.eventTitle', { minutes: event.reminderMinutesBefore }),
    body: event.title,
    at: new Date(starts - event.reminderMinutesBefore * 60 * 1000),
  });
}

/** Clears every scheduled reminder — used when all data is wiped. */
export async function cancelAllReminders(): Promise<void> {
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
  } catch {
    /* nothing scheduled */
  }
  await writeHandles({});
}
