import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';

import { api, type Event, type Task } from './api';
import { t } from './i18n';
import { scheduleReminder } from './notifications';
import { storage, type Profile } from './storage';
import { estimateTravelMinutes } from './travel';
import { fetchOpportunityNudge } from './voice';

// Proactive pattern-based notifications.
//
// A background fetch task runs roughly every 15-30 minutes (iOS decides the
// exact interval based on usage patterns). When it fires, it inspects
// tomorrow's schedule for density and notifies the user if something stands
// out: too many meetings, no breaks, a very early start, etc.
//
// It also sends a morning briefing at wake time if the day ahead is noteworthy.

const PROACTIVE_TASK = 'PA_PROACTIVE';
const PROACTIVE_KEY = '@pa/proactiveLast';

function isDuringSleep(profile: Profile): boolean {
  const hour = new Date().getHours();
  const { sleepStartHour, sleepEndHour } = profile;
  if (sleepStartHour > sleepEndHour) {
    return hour >= sleepStartHour || hour < sleepEndHour;
  }
  return hour >= sleepStartHour && hour < sleepEndHour;
}

function localDay(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function tomorrowStr(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return localDay(d.toISOString());
}

function todayStr(): string {
  return localDay(new Date().toISOString());
}

type DayAnalysis = {
  eventCount: number;
  taskCount: number;
  hasBackToBack: boolean;
  earliestEventHour: number | null;
  totalMeetingHours: number;
  busyLevel: 'light' | 'moderate' | 'packed';
};

function analyzeDay(events: Event[], tasks: Task[]): DayAnalysis {
  const liveEvents = events.filter((e) => !e.deletedAt && !e.endedAt);
  const liveTasks = tasks.filter((t) => !t.deletedAt && !t.isDone);

  const sorted = [...liveEvents].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()
  );

  let hasBackToBack = false;
  for (let i = 1; i < sorted.length; i++) {
    const prevEnd = new Date(sorted[i - 1].endsAt).getTime();
    const nextStart = new Date(sorted[i].startsAt).getTime();
    if (nextStart - prevEnd < 15 * 60_000) {
      hasBackToBack = true;
      break;
    }
  }

  let totalMeetingMinutes = 0;
  for (const e of liveEvents) {
    const start = new Date(e.startsAt).getTime();
    const end = new Date(e.endsAt).getTime();
    totalMeetingMinutes += (end - start) / 60_000;
  }

  const earliestEventHour = sorted.length > 0
    ? new Date(sorted[0].startsAt).getHours()
    : null;

  const busyLevel: DayAnalysis['busyLevel'] =
    liveEvents.length >= 5 || totalMeetingMinutes >= 300 ? 'packed' :
    liveEvents.length >= 3 || totalMeetingMinutes >= 180 ? 'moderate' :
    'light';

  return {
    eventCount: liveEvents.length,
    taskCount: liveTasks.length,
    hasBackToBack,
    earliestEventHour,
    totalMeetingHours: Math.round(totalMeetingMinutes / 60),
    busyLevel,
  };
}

async function getLastRun(): Promise<{ date: string; type: string } | null> {
  try {
    const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
    const raw = await AsyncStorage.getItem(PROACTIVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function setLastRun(date: string, type: string): Promise<void> {
  try {
    const { default: AsyncStorage } = await import('@react-native-async-storage/async-storage');
    await AsyncStorage.setItem(PROACTIVE_KEY, JSON.stringify({ date, type }));
  } catch { /* best effort */ }
}

TaskManager.defineTask(PROACTIVE_TASK, async () => {
  try {
    const settings = await storage.getSettings();
    if (!settings.notifications) return BackgroundFetch.BackgroundFetchResult.NoData;

    const profile = await storage.getProfile();
    if (isDuringSleep(profile)) return BackgroundFetch.BackgroundFetchResult.NoData;

    const last = await getLastRun();
    const today = todayStr();
    const tomorrow = tomorrowStr();
    const hour = new Date().getHours();

    // Morning "get ready" nudge — the stakeholder's one hard ask.
    //
    // Runs in the hour BEFORE wake time: iOS wakes background fetch every
    // ~15–30 min, so the first firing after sleepEndHour-1 is our chance to
    // schedule a notification at the exact moment the user needs to start
    // moving. The math: firstEvent.startsAt − travelMinutes − prepTime. If
    // the result is in the past (the first event is close, or there is no
    // travel), the ordinary 15-min-before reminder has it covered.
    //
    // We also still fall through to the generic briefing below when there
    // is no first-event-with-location — a user with only tasks or in-office
    // meetings should still hear from her in the morning.
    if (last?.type !== `getready-${today}` && hour >= profile.sleepEndHour - 1 && hour <= profile.sleepEndHour + 1) {
      const agenda = await api.agendaForDate(today);
      const liveEvents = agenda.events
        .filter((e) => !e.deletedAt && !e.endedAt)
        .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
      const first = liveEvents[0];
      if (first) {
        const startMs = new Date(first.startsAt).getTime();
        const travelMin = await estimateTravelMinutes(first.location) ?? 0;
        const prepMin = profile.prepTimeMinutes ?? 30;
        const leaveReadyMs = startMs - (travelMin + prepMin) * 60_000;
        // Only schedule if the nudge still has somewhere to land ahead of
        // the event — otherwise the normal event reminder is enough.
        if (leaveReadyMs > Date.now() + 60_000) {
          const firstTime = new Date(startMs).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          });
          const body = travelMin > 0
            ? t('notify.morningGetReadyWithTravel', {
                title: first.title,
                time: firstTime,
                travel: travelMin,
                prep: prepMin,
              })
            : t('notify.morningGetReady', {
                title: first.title,
                time: firstTime,
                prep: prepMin,
              });
          await scheduleReminder({
            rowId: `proactive-getready-${today}`,
            title: t('notify.morningTitle'),
            body,
            at: new Date(leaveReadyMs),
          });
          await setLastRun(today, `getready-${today}`);
          return BackgroundFetch.BackgroundFetchResult.NewData;
        }
      }
    }

    // Morning briefing: once per day, around wake time
    if (last?.date !== today && last?.type !== `briefing-${today}` && hour >= profile.sleepEndHour && hour < profile.sleepEndHour + 2) {
      const agenda = await api.agendaForDate(today);
      const analysis = analyzeDay(agenda.events, agenda.tasks);

      if (analysis.eventCount > 0 || analysis.taskCount > 0) {
        const body = analysis.busyLevel === 'packed'
          ? t('notify.morningPacked', { events: analysis.eventCount, tasks: analysis.taskCount })
          : analysis.busyLevel === 'moderate'
          ? t('notify.morningModerate', { events: analysis.eventCount, tasks: analysis.taskCount })
          : t('notify.morningLight', { events: analysis.eventCount, tasks: analysis.taskCount });

        await scheduleReminder({
          rowId: `proactive-morning-${today}`,
          title: t('notify.morningTitle'),
          body,
          at: new Date(Date.now() + 2000),
        });
        await setLastRun(today, `briefing-${today}`);
        return BackgroundFetch.BackgroundFetchResult.NewData;
      }
    }

    // "Time just opened up" — the second half of the stakeholder's ask. A
    // user whose next meeting is still an hour away, with open tasks on
    // their list, should hear from her once per such window rather than
    // waking up to it or finding out when they check.
    //
    // We fire during the user's work hours only, dedup by hour (so a
    // 90-minute window doesn't nudge twice), and skip when the gap is
    // actually just the end of the day. A smaller than 45-minute window
    // isn't worth interrupting for.
    if (hour >= profile.workStartHour && hour < profile.workEndHour) {
      const slot = `freed-${today}-${hour}`;
      if (last?.type !== slot) {
        const agenda = await api.agendaForDate(today);
        const live = agenda.events
          .filter((e) => !e.deletedAt && !e.endedAt)
          .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
        const now = Date.now();
        const next = live.find((e) => new Date(e.startsAt).getTime() > now);
        const gapMin = next
          ? Math.round((new Date(next.startsAt).getTime() - now) / 60_000)
          : Math.max(0, (profile.workEndHour - hour) * 60);

        const openTasks = agenda.tasks.filter((task) => !task.deletedAt && !task.isDone);
        if (gapMin >= 45 && openTasks.length > 0) {
          // First ask the backend whether this is a "stop at the mall on
          // the way" moment: it joins GPS + the local places index + the
          // open tasks and either hands back a pre-rendered push body
          // naming a concrete place, or signals nothing-specific. We only
          // fall through to the plain "you have N min — task" nudge when
          // nothing concrete fits.
          const opp = await fetchOpportunityNudge();
          if (opp?.shouldNudge) {
            await scheduleReminder({
              rowId: `proactive-${slot}`,
              title: opp.title,
              body: opp.body,
              at: new Date(now + 2000),
            });
            await setLastRun(today, slot);
            return BackgroundFetch.BackgroundFetchResult.NewData;
          }

          const nextLabel = next
            ? `${new Date(next.startsAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} ${next.title}`
            : null;
          const body = nextLabel
            ? t('notify.freedBeforeNext', { minutes: gapMin, next: nextLabel, task: openTasks[0]!.title })
            : t('notify.freedOpen', { minutes: gapMin, task: openTasks[0]!.title });
          await scheduleReminder({
            rowId: `proactive-${slot}`,
            title: t('notify.freedTitle'),
            body,
            at: new Date(now + 2000),
          });
          await setLastRun(today, slot);
          return BackgroundFetch.BackgroundFetchResult.NewData;
        }
      }
    }

    // Evening preview: once per day in the evening, before sleep
    if (last?.type !== `preview-${tomorrow}` && hour >= 19 && hour < profile.sleepStartHour) {
      const agenda = await api.agendaForDate(tomorrow);
      const analysis = analyzeDay(agenda.events, agenda.tasks);

      if (analysis.busyLevel === 'packed') {
        await scheduleReminder({
          rowId: `proactive-preview-${tomorrow}`,
          title: t('notify.eveningTitle'),
          body: t('notify.eveningPacked', { events: analysis.eventCount, tasks: analysis.taskCount }),
          at: new Date(Date.now() + 2000),
        });
        await setLastRun(today, `preview-${tomorrow}`);
        return BackgroundFetch.BackgroundFetchResult.NewData;
      }

      if (analysis.hasBackToBack) {
        await scheduleReminder({
          rowId: `proactive-preview-${tomorrow}`,
          title: t('notify.eveningTitle'),
          body: t('notify.eveningBackToBack'),
          at: new Date(Date.now() + 2000),
        });
        await setLastRun(today, `preview-${tomorrow}`);
        return BackgroundFetch.BackgroundFetchResult.NewData;
      }

      if (analysis.earliestEventHour !== null && analysis.earliestEventHour < 8) {
        await scheduleReminder({
          rowId: `proactive-preview-${tomorrow}`,
          title: t('notify.eveningTitle'),
          body: t('notify.eveningEarlyStart', { hour: analysis.earliestEventHour }),
          at: new Date(Date.now() + 2000),
        });
        await setLastRun(today, `preview-${tomorrow}`);
        return BackgroundFetch.BackgroundFetchResult.NewData;
      }
    }

    return BackgroundFetch.BackgroundFetchResult.NoData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerProactiveTask(): Promise<void> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(PROACTIVE_TASK);
    if (isRegistered) return;

    await BackgroundFetch.registerTaskAsync(PROACTIVE_TASK, {
      minimumInterval: 15 * 60,
      stopOnTerminate: false,
      startOnBoot: true,
    });
  } catch { /* background fetch not available */ }
}

export async function unregisterProactiveTask(): Promise<void> {
  try {
    await BackgroundFetch.unregisterTaskAsync(PROACTIVE_TASK);
  } catch { /* not registered */ }
}

export { isDuringSleep };
