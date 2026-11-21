import { Router } from 'express';
import { z } from 'zod';

import { asyncHandler, parseBody } from '../../lib/http.js';
import { mapsLimiter } from '../../middleware/rateLimit.js';
import { classifyErrand } from '../voice/errand-classifier.js';
import { searchNearby, distanceKm, travelMinutes, drivingMinutes } from '../voice/travel.js';
import { TtlCache, normalizePlaceText } from './cache.js';
import { googleGeocode, isGoogleEnabled, type ResolvedPlace } from './google.js';

/**
 * Maps endpoints for the device (stateless, like /voice/*).
 *
 * The device owns the events; these routes only answer questions about
 * places, so they need the server's key but no account. `mapsLimiter` is the
 * per-device ceiling; the daily dollar budget in budget.ts is the global one.
 */
export const mapsRouter = Router();

const point = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

// ── POST /maps/resolve ──────────────────────────────────────────────────────
//
// Text → coordinates, once per event. The device calls this only after its
// own (free) geocoder came back empty, stores the answer on the event, and
// never asks for that event again.

const resolveBody = z.object({
  text: z.string().trim().min(1).max(200),
  language: z.string().regex(/^[a-z]{2}$/).default('he'),
});

const resolveCache = new TtlCache<ResolvedPlace | null>(5_000, 30 * 24 * 60 * 60_000);

mapsRouter.post(
  '/maps/resolve',
  mapsLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(resolveBody, req);
    if (!isGoogleEnabled()) {
      res.json({ place: null, source: 'disabled' });
      return;
    }
    const key = `${body.language}:${normalizePlaceText(body.text)}`;
    let place = resolveCache.get(key);
    if (place === undefined) {
      place = await googleGeocode(body.text, { language: body.language });
      resolveCache.set(key, place, place ? undefined : 24 * 60 * 60_000);
    }
    res.json({ place, source: place ? 'google' : 'none' });
  }),
);

// ── POST /maps/eta ──────────────────────────────────────────────────────────
//
// Live-traffic driving time for the "time to leave" alert. The device calls
// it once per event, about an hour before leaving, and only when its own
// estimate says the drive is longer than a quarter of an hour.

const etaBody = z.object({
  from: point,
  to: point,
  /** When the user means to arrive — helps nothing on Google's side, but
   * lets a trip too far in the future be refused instead of paid for. */
  arriveBy: z.string().datetime({ offset: true }).optional(),
});

/** Traffic for a meeting three hours away is noise; ask again closer to it. */
const ETA_MAX_LEAD_MS = 3 * 60 * 60_000;

mapsRouter.post(
  '/maps/eta',
  mapsLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(etaBody, req);
    const km = distanceKm(body.from, body.to);
    const floor = travelMinutes(km);
    const tooEarly =
      body.arriveBy !== undefined && Date.parse(body.arriveBy) - Date.now() > ETA_MAX_LEAD_MS;
    // Ask for the traffic at the moment they would leave, not at the moment
    // of asking — an hour out, the two can differ by a rush hour.
    const departAt = body.arriveBy
      ? new Date(Date.parse(body.arriveBy) - floor * 60_000)
      : undefined;
    const live =
      km >= 1 && !tooEarly
        ? await drivingMinutes(body.from, body.to, { traffic: true, departAt })
        : null;
    res.json({
      minutes: live ?? floor,
      withTraffic: live !== null,
      distanceKm: Math.round(km * 10) / 10,
    });
  }),
);

// ── POST /maps/errand-fences ────────────────────────────────────────────────
//
// The places worth a geofence: for each open task that names an errand, the
// nearest matching shops from the local OSM snapshot. Free — no Google here —
// and capped well under iOS's 20-regions-per-app limit, which the device
// shares with its event geofences.

const fencesBody = z.object({
  near: point,
  tasks: z
    .array(z.object({ id: z.string().min(1).max(100), title: z.string().max(300) }))
    .max(100),
  /** How many regions the device can spare. */
  max: z.number().int().min(1).max(15).default(10),
  radiusMeters: z.number().int().min(500).max(20_000).default(5_000),
});

/** Per task, so one errand cannot take every slot. */
const FENCES_PER_TASK = 3;

mapsRouter.post(
  '/maps/errand-fences',
  mapsLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(fencesBody, req);
    const fences: {
      id: string;
      taskId: string;
      taskTitle: string;
      placeName: string;
      category: string;
      latitude: number;
      longitude: number;
      distanceKm: number;
    }[] = [];
    const taken = new Set<string>();

    for (const task of body.tasks) {
      if (fences.length >= body.max) break;
      const match = classifyErrand(task.title);
      if (!match) continue;
      const places = await searchNearby(body.near, match.category, body.radiusMeters, FENCES_PER_TASK);
      for (const p of places) {
        if (fences.length >= body.max) break;
        const id = `${p.latitude.toFixed(5)},${p.longitude.toFixed(5)}`;
        if (taken.has(id)) continue;
        taken.add(id);
        fences.push({
          id,
          taskId: task.id,
          taskTitle: task.title,
          placeName: p.name,
          category: match.category,
          latitude: p.latitude,
          longitude: p.longitude,
          distanceKm: p.distanceKm,
        });
      }
    }
    res.json({ fences });
  }),
);
