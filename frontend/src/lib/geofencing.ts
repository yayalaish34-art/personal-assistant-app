import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { api, type Event } from './api';
import { t } from './i18n';
import { scheduleReminder, cancelReminder } from './notifications';
import { storage } from './storage';

// Geofencing: automatic arrival detection for events with a location.
//
// When a new event is created with a location field, we geocode it and
// register a geofence. When the user enters that geofence, they get a
// notification like "You've arrived — your meeting starts in 10 minutes".
//
// Requires: expo-task-manager + background location permission.

const GEOFENCE_TASK = 'PA_GEOFENCE';
const GEOFENCE_RADIUS_M = 200;

type GeofenceEntry = {
  eventId: string;
  eventTitle: string;
  startsAt: string;
  latitude: number;
  longitude: number;
};

let registered = false;

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) return;
  const { eventType, region } = (data as {
    eventType: Location.GeofencingEventType;
    region: Location.LocationRegion;
  });

  if (eventType !== Location.GeofencingEventType.Enter) return;

  const eventId = region.identifier;
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
  for (const event of upcoming.slice(0, 10)) {
    const coords = await geocodeLocation(event.location!);
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

  try {
    if (regions.length > 0) {
      await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
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
