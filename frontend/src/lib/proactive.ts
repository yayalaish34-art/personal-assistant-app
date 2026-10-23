import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';

import { api, type Event, type Task } from './api';
import { t } from './i18n';
import { scheduleReminder } from './notifications';
import { storage, type Profile } from './storage';

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
