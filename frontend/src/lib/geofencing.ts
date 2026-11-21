import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { api } from './api';
import { t } from './i18n';
import { scheduleReminder } from './notifications';
import { fetchErrandFences, type ErrandFence } from './places';
import { storage } from './storage';
import { currentOrLastKnown, eventPoint } from './travel';

// Geofencing — two kinds of region, both watched by the OS for free.
//
// 1. Arrival at an event with a location: "You've arrived — your meeting
//    starts in 10 minutes".
// 2. Passing a store that fits an open errand (opt-in, `settings.errandAlerts`):
//    "Near Super-Pharm — time for 'pick up the prescription'?". The stores
//    come from the server's local OSM snapshot (`/maps/errand-fences`), so no
//    paid request is ever made to find them, and the OS does the watching.
//
// iOS allows 20 regions per app across everything, so events take up to 10
// and errands get what is left, never more than 9.
//
// Requires: expo-task-manager + background ("Always") location permission.

const GEOFENCE_TASK = 'PA_GEOFENCE';
const GEOFENCE_RADIUS_M = 200;
/** Store fences are wider: "near" is a block or two, not the door. */
const ERRAND_RADIUS_M = 300;

const MAX_REGIONS = 19; // iOS caps at 20; one spare.
const MAX_EVENT_REGIONS = 10;
const ERRAND_PREFIX = 'errand:';

/** Re-ask the server for stores only after moving this far, or tasks change. */
const REFETCH_DISTANCE_KM = 5;
const REFETCH_MAX_AGE_MS = 24 * 60 * 60_000;
/** Don't buzz for an errand if the next meeting starts sooner than this. */
const MIN_FREE_MINUTES = 20;

const FENCES_KEY = '@pa/errandFences';
const FIRED_KEY = '@pa/errandFired';

type FenceCache = {
  center: { latitude: number; longitude: number };
  taskKey: string;
  fetchedAt: number;
  fences: ErrandFence[];
};

let registered = false;

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) return;
  const { eventType, region } = (data as {
    eventType: Location.GeofencingEventType;
    region: Location.LocationRegion;
  });

  if (eventType !== Location.GeofencingEventType.Enter) return;

  const id = region.identifier ?? '';
  if (id.startsWith(ERRAND_PREFIX)) {
    await onErrandEnter(id.slice(ERRAND_PREFIX.length));
    return;
  }

  const eventId = id;
  const events = (await api.listEvents()).events;
  const event = events.find((e) => e.id === eventId && !e.deletedAt);
  if (!event) return;

  const startsAt = new Date(event.startsAt).getTime();
  const now = Date.now();
  const minutesUntil = Math.round((startsAt - now) / 60_000);

  if (minutesUntil < -30) return;

  const settings = await storage.getSettings();
  if (!settings.notifications) return;

  const title = t('notify.arrivedTitle');
  const body = minutesUntil > 0
    ? t('notify.arrivedBody', { title: event.title, minutes: minutesUntil })
    : t('notify.arrivedBodyNow', { title: event.title });

  await scheduleReminder({
    rowId: `arrival-${eventId}`,
    title,
    body,
    at: new Date(now + 2000),
  });

  try {
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
  } catch { /* may not be running */ }
  void refreshGeofences();
});

/** "Near a store for an open errand" — at most once a day per store. */
async function onErrandEnter(fenceId: string): Promise<void> {
  const settings = await storage.getSettings();
  if (!settings.notifications || !settings.errandAlerts) return;

  const cache = await readFenceCache();
  const fence = cache?.fences.find((f) => f.id === fenceId);
  if (!fence) return;

  // The task may have been done since the fence was registered.
  const { tasks } = await api.listTasks();
  const task = tasks.find((x) => x.id === fence.taskId && !x.isDone && !x.deletedAt);
  if (!task) return;

  const profile = await storage.getProfile();
  const hour = new Date().getHours();
  const asleep =
    profile.sleepStartHour > profile.sleepEndHour
      ? hour >= profile.sleepStartHour || hour < profile.sleepEndHour
      : hour >= profile.sleepStartHour && hour < profile.sleepEndHour;
  if (asleep) return;

  // Only when there is actually time: the next meeting is the judge.
  const now = Date.now();
  const { events } = await api.listEvents();
  const next = events
    .filter((e) => !e.deletedAt && !e.endedAt && new Date(e.startsAt).getTime() > now)
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];
  const freeMin = next ? Math.round((new Date(next.startsAt).getTime() - now) / 60_000) : null;
  if (freeMin !== null && freeMin < MIN_FREE_MINUTES) return;

  const today = new Date().toISOString().slice(0, 10);
  let fired: Record<string, string> = {};
  try {
    fired = JSON.parse((await AsyncStorage.getItem(FIRED_KEY)) ?? '{}');
  } catch {
    fired = {};
  }
  if (fired[fence.id] === today) return;
  fired[fence.id] = today;
  for (const k of Object.keys(fired)) if (fired[k] !== today) delete fired[k];
  try {
    await AsyncStorage.setItem(FIRED_KEY, JSON.stringify(fired));
  } catch { /* best effort */ }

  await scheduleReminder({
    rowId: `errand-${fence.id}`,
    title: t('notify.errandNearTitle', { place: fence.placeName }),
    body: freeMin !== null
      ? t('notify.errandNearBodyMinutes', { task: task.title, minutes: freeMin })
      : t('notify.errandNearBody', { task: task.title }),
    at: new Date(now + 2000),
  });
}

async function readFenceCache(): Promise<FenceCache | null> {
  try {
    const raw = await AsyncStorage.getItem(FENCES_KEY);
    return raw ? (JSON.parse(raw) as FenceCache) : null;
  } catch {
    return null;
  }
}

function kmBetween(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The store fences to register, from cache when nothing relevant changed.
 * The server is asked only when the open tasks differ, the phone moved more
 * than a few kilometres, or a day has passed.
 */
async function errandFences(max: number): Promise<ErrandFence[]> {
  if (max <= 0) return [];
  const here = await currentOrLastKnown();
  if (!here) return (await readFenceCache())?.fences.slice(0, max) ?? [];

  const { tasks } = await api.listTasks();
  const open = tasks.filter((x) => !x.isDone && !x.deletedAt);
  const taskKey = open.map((x) => `${x.id}:${x.title}`).sort().join('|');

  const cache = await readFenceCache();
  const fresh =
    cache &&
    cache.taskKey === taskKey &&
    Date.now() - cache.fetchedAt < REFETCH_MAX_AGE_MS &&
    kmBetween(cache.center, here) < REFETCH_DISTANCE_KM;
  if (fresh) return cache.fences.slice(0, max);

  const fences = await fetchErrandFences(here, open, max);
  if (!fences) return cache?.fences.slice(0, max) ?? []; // offline: keep the old ones
  const next: FenceCache = { center: here, taskKey, fetchedAt: Date.now(), fences };
  try {
    await AsyncStorage.setItem(FENCES_KEY, JSON.stringify(next));
  } catch { /* best effort */ }
  return fences;
}

async function hasBackgroundPermission(): Promise<boolean> {
  try {
    const { status } = await Location.getBackgroundPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

export async function requestBackgroundLocation(): Promise<boolean> {
  try {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') return false;
    const bg = await Location.requestBackgroundPermissionsAsync();
    return bg.status === 'granted';
  } catch {
    return false;
  }
}

async function geocodeLocation(text: string): Promise<{ latitude: number; longitude: number } | null> {
  try {
    const results = await Location.geocodeAsync(text);
    if (results.length > 0) {
      return { latitude: results[0].latitude, longitude: results[0].longitude };
    }
  } catch { /* geocoding can fail */ }
  return null;
}

export async function refreshGeofences(): Promise<void> {
  if (!(await hasBackgroundPermission())) return;

  const settings = await storage.getSettings();
  if (!settings.notifications) return;

  const { events } = await api.listEvents();
  const now = Date.now();
  const ahead = 24 * 60 * 60 * 1000;

  const upcoming = events.filter((e) =>
    !e.deletedAt &&
    !e.endedAt &&
    e.location?.trim() &&
    new Date(e.startsAt).getTime() > now - 30 * 60_000 &&
    new Date(e.startsAt).getTime() < now + ahead
  );

  const regions: Location.LocationRegion[] = [];
  for (const event of upcoming.slice(0, MAX_EVENT_REGIONS)) {
    // Saved coordinates first; the OS geocoder only for older events.
    const coords = eventPoint(event) ?? (await geocodeLocation(event.location!));
    if (!coords) continue;
    regions.push({
      identifier: event.id,
      latitude: coords.latitude,
      longitude: coords.longitude,
      radius: GEOFENCE_RADIUS_M,
      notifyOnEnter: true,
      notifyOnExit: false,
    });
  }

  if (settings.errandAlerts) {
    try {
      const fences = await errandFences(MAX_REGIONS - regions.length);
      for (const f of fences) {
        regions.push({
          identifier: `${ERRAND_PREFIX}${f.id}`,
          latitude: f.latitude,
          longitude: f.longitude,
          radius: ERRAND_RADIUS_M,
          notifyOnEnter: true,
          notifyOnExit: false,
        });
      }
    } catch { /* store fences are a bonus; event fences still register */ }
  }

  try {
    if (regions.length > 0) {
      await Location.startGeofencingAsync(GEOFENCE_TASK, regions.slice(0, MAX_REGIONS));
      registered = true;
    } else if (registered) {
      await Location.stopGeofencingAsync(GEOFENCE_TASK);
      registered = false;
    }
  } catch { /* geofencing not available */ }
}

export async function stopGeofencing(): Promise<void> {
  try {
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
  } catch { /* not running */ }
  registered = false;
}
