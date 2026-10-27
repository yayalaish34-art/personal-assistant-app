import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { t } from './i18n';
import { REMINDER_CHANNEL, requestNotifications } from './permissions';
import { storage } from './storage';

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
export function configureOnce(): void {
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
 * Whether a reminder may be posted.
 *
 * Onboarding normally asks for this with a sentence of context, so by the time
 * anything is scheduled the answer is usually already known and no prompt
 * appears. Someone who skipped that step is still asked here, at the point of
 * first use. Either way a no is not an error worth interrupting anyone for:
 * scheduling quietly does nothing and the row saves as it always did.
 *
 * The Android channel is created inside `requestNotifications`, including on
 * the already-granted path — see the note there about why that matters.
 */
async function ensurePermission(): Promise<boolean> {
  configureOnce();
  return (await requestNotifications()) === 'granted';
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
 * If a notification would fire during the user's sleep window, push it to
 * wake time instead. This respects the profile's sleepStartHour/sleepEndHour.
 */
async function respectSleepHours(at: Date): Promise<Date> {
  try {
    const profile = await storage.getProfile();
    const { sleepStartHour, sleepEndHour } = profile;
    const hour = at.getHours();
    const crossesMidnight = sleepStartHour > sleepEndHour;

    const isSleeping = crossesMidnight
      ? hour >= sleepStartHour || hour < sleepEndHour
      : hour >= sleepStartHour && hour < sleepEndHour;

    if (!isSleeping) return at;

    const wake = new Date(at);
    if (crossesMidnight && hour >= sleepStartHour) {
      wake.setDate(wake.getDate() + 1);
    }
    wake.setHours(sleepEndHour, 0, 0, 0);
    return wake;
  } catch {
    return at;
  }
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

  const adjusted = await respectSleepHours(input.at);
  if (Number.isNaN(adjusted.getTime()) || adjusted.getTime() <= Date.now()) return;
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
        date: adjusted,
        ...(Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL } : {}),
      },
    });
    const handles = await readHandles();
    handles[input.rowId] = handle;
    await writeHandles(handles);
  } catch {
    /* scheduling is best-effort; the row is saved either way */
  }
}

/**
 * A task rings ahead of its due time by the user's chosen lead time
 * (`taskReminderMinutes` on the profile; default 15 minutes). Setting the lead
 * to zero preserves the old behaviour of ringing right on the due minute.
 */
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

  const due = new Date(task.dueAt).getTime();
  if (Number.isNaN(due)) return;

  let leadMinutes = 15;
  try {
    const profile = await storage.getProfile();
    const n = Number(profile.taskReminderMinutes);
    if (Number.isFinite(n) && n >= 0) leadMinutes = Math.round(n);
  } catch {
    /* fall back to the default lead */
  }

  await scheduleReminder({
    rowId: task.id,
    title: t('notify.taskTitle', { title: task.title }),
    body:
      leadMinutes > 0
        ? t('notify.taskBodyLead', { minutes: leadMinutes })
        : t('notify.taskBody'),
    at: new Date(due - leadMinutes * 60 * 1000),
  });
}

/** An event rings ahead of its start with contextual, human text. */
export async function scheduleEventReminder(event: {
  id: string;
  title: string;
  startsAt: string;
  location?: string | null;
  reminderMinutesBefore: number | null;
}): Promise<void> {
  if (event.reminderMinutesBefore === null || event.reminderMinutesBefore === undefined) {
    await cancelReminder(event.id);
    return;
  }
  const starts = new Date(event.startsAt).getTime();
  if (Number.isNaN(starts)) return;

  const mins = event.reminderMinutesBefore;
  const loc = event.location?.trim();

  const body = loc
    ? t('notify.eventBodyLocation', { title: event.title, location: loc, minutes: mins })
    : t('notify.eventBody', { title: event.title, minutes: mins });

  await scheduleReminder({
    rowId: event.id,
    title: t('notify.eventTitle'),
    body,
    at: new Date(starts - mins * 60 * 1000),
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
