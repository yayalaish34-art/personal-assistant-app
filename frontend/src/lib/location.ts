import * as Location from 'expo-location';

export interface DeviceLocation {
  latitude: number;
  longitude: number;
  city?: string;
  country?: string;
}

let current: DeviceLocation | null = null;
let watching = false;
let sub: Location.LocationSubscription | null = null;

export function getLocation(): DeviceLocation | null {
  return current;
}

/**
 * Begin tracking. On the first voice session, which calls this, the asker
 * version prompts the user. Everywhere else it starts silently — the launch
 * path uses `requireExistingPermission: true` so the OS dialog never
 * appears mid-splash — and both routes end up at the same tracker.
 */
export async function startLocationTracking(opts?: {
  /** Don't prompt; only start if permission is already granted. */
  requireExistingPermission?: boolean;
}): Promise<void> {
  if (watching) return;

  if (opts?.requireExistingPermission) {
    const existing = await Location.getForegroundPermissionsAsync();
    if (existing.status !== 'granted') return;
  } else {
    const asked = await Location.requestForegroundPermissionsAsync();
    if (asked.status !== 'granted') return;
  }

  try {
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    current = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    void reverseGeocode(pos.coords.latitude, pos.coords.longitude);
  } catch {
    // Will pick up from the watch callback
  }

  watching = true;
  sub = await Location.watchPositionAsync(
    {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 60_000,
      distanceInterval: 100,
    },
    (pos) => {
      current = {
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        ...(current?.city ? { city: current.city } : {}),
        ...(current?.country ? { country: current.country } : {}),
      };
      void reverseGeocode(pos.coords.latitude, pos.coords.longitude);
    },
  );
}

export function stopLocationTracking(): void {
  if (sub) {
    sub.remove();
    sub = null;
  }
  watching = false;
}

async function reverseGeocode(latitude: number, longitude: number): Promise<void> {
  try {
    const [result] = await Location.reverseGeocodeAsync({ latitude, longitude });
    if (result && current) {
      current = {
        ...current,
        latitude,
        longitude,
        ...(result.city ? { city: result.city } : {}),
        ...(result.country ? { country: result.country } : {}),
      };
    }
  } catch {
    // Geocoding can fail silently — keep coordinates
  }
}
