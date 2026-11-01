/**
 * Pure geo primitives shared by `travel.ts` and the local places index.
 * Lives on its own so the index can use `distanceKm` without pulling the
 * geocoder (and its network calls) into module init, and without the
 * circular import that would otherwise appear.
 */

export interface Point {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: Point, b: Point): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
