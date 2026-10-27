import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { t } from './i18n';
import { REMINDER_CHANNEL, requestNotifications } from './permissions';
import { storage } from './storage';
import { estimateTravelMinutes } from './travel';

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
 * wake time instead — unless doing so would land it *after* the thing it is
 * reminding about. A 7 AM meeting with a 15-minute lead sits at 06:45, which
 * is in most people's sleep window; shifting it to wake-time silently fires
 * the reminder after the meeting is already underway, which is the exact
 * failure the stakeholder flagged ("notifications never arrive"). So: when
 * the shifted time would pass the actual due moment, hold the original time
 * — the user asked to be reminded, and a quiet buzz at 06:45 is better than
 * a chime at 07:30 for a meeting that started at 07:00.
 */
async function respectSleepHours(at: Date, notAfter?: Date): Promise<Date> {
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

    // Would shifting push the reminder past the actual event? Keep the
    // original time — late reminders are worse than quiet ones.
    if (notAfter && wake.getTime() >= notAfter.getTime()) return at;

    return wake;
  } catch {
    return at;
  }
}

/**
 * Schedules one reminder for a row, replacing any it already had.
 *
 * A time in the past schedules nothing — it would fire immediately, which
 * reads as a bug rather than a reminder. `notAfter` is the moment the
 * reminder is for (the task's due time, the event's start): it caps the
 * sleep-hours shift so a lead reminder is never pushed past the thing it is
 * announcing.
 */
export async function scheduleReminder(input: {
  rowId: string;
  title: string;
  body?: string;
  /** When it should fire. */
  at: Date;
  /** The event/task time itself — a sleep-hour shift stops here. */
  notAfter?: Date;
}): Promise<void> {
  await cancelReminder(input.rowId);

  const adjusted = await respectSleepHours(input.at, input.notAfter);
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
    notAfter: new Date(due),
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
    notAfter: new Date(starts),
  });

  // A second buzz for events with a place: "time to head out, drive is
  // about N min". Only fires when the device can give an honest travel
  // estimate (recent fix + geocodable name + a non-trivial distance), and
  // only when the leave moment is far enough from the prep reminder to be
  // its own thing — otherwise one notification is enough.
  await scheduleEventLeaveReminder(event);
}

/**
 * The "time to leave" reminder — a travel-aware second buzz for events with
 * a `location`. Separate id from the main reminder so both can co-exist; a
 * null estimate (no permission, no fix, unknown place, nearby) cancels this
 * one silently and leaves the ordinary prep reminder in place.
 */
export async function scheduleEventLeaveReminder(event: {
  id: string;
  title: string;
  startsAt: string;
  location?: string | null;
}): Promise<void> {
  const leaveId = `leave-${event.id}`;
  const loc = event.location?.trim();
  if (!loc) {
    await cancelReminder(leaveId);
    return;
  }
  const starts = new Date(event.startsAt).getTime();
  if (Number.isNaN(starts)) return;

  const travelMin = await estimateTravelMinutes(loc);
  if (travelMin === null) {
    await cancelReminder(leaveId);
    return;
  }

  const leaveAt = new Date(starts - travelMin * 60 * 1000);
  // If the leave moment sits inside the ordinary prep window — i.e. earlier
  // than or very close to the prep reminder — the two would stack. Skip:
  // the regular reminder already covers it.
  if (leaveAt.getTime() <= Date.now()) {
    await cancelReminder(leaveId);
    return;
  }

  await scheduleReminder({
    rowId: leaveId,
    title: t('notify.eventTitle'),
    body: t('notify.eventBodyTravel', { title: event.title, travel: travelMin }),
    at: leaveAt,
    notAfter: new Date(starts),
  });
}

/**
 * Fired right after the user marks a meeting as finished early — the
 * freed-time nudge the stakeholder keeps citing. Pulls `minutes` from the
 * gap between the actual end and the scheduled end, references the next
 * thing on today's agenda when there is one. Returns silently if the gap is
 * too small to matter (anything under 15 minutes is just the meeting
 * running a touch short), or if nothing changed.
 */
export async function fireFreedTimeNotice(input: {
  endedAtMs: number;
  scheduledEndMs: number;
  nextStartsAt?: Date | null;
  nextTitle?: string | null;
}): Promise<void> {
  const freedMs = input.scheduledEndMs - input.endedAtMs;
  const freedMin = Math.round(freedMs / 60_000);
  if (freedMin < 15) return;

  if (!(await ensurePermission())) return;

  // How long is the window until the next thing lands? If nothing is next,
  // say the whole day is free; otherwise show the gap and the next anchor.
  let body: string;
  if (input.nextStartsAt && input.nextTitle) {
    const gapMin = Math.max(
      0,
      Math.round((input.nextStartsAt.getTime() - input.endedAtMs) / 60_000),
    );
    const nextLabel = formatTimeShort(input.nextStartsAt) + ' ' + input.nextTitle;
    body = t('notify.endedEarlyBody', { minutes: gapMin, next: nextLabel });
  } else {
    body = t('notify.endedEarlyNoNext');
  }

  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: t('notify.endedEarly'),
        body,
        sound: true,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date: new Date(Date.now() + 1500),
        ...(Platform.OS === 'android' ? { channelId: REMINDER_CHANNEL } : {}),
      },
    });
  } catch {
    /* best effort; the schedule-wipe path below cleans up */
  }
}

function formatTimeShort(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
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
