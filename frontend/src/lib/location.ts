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

export async function startLocationTracking(): Promise<void> {
  if (watching) return;

  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== 'granted') return;

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
