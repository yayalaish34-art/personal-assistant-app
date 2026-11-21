/**
 * A small LRU with per-entry expiry.
 *
 * Every paid Google answer goes through one of these, so the same question
 * asked twice in a turn, or by the scheduler's candidate loop sixteen times
 * over, is paid for once. Lives in process memory on purpose: the answers are
 * cheap to lose (a restart costs a few repeat lookups) and Google's terms only
 * allow keeping most of them for a limited time anyway.
 */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly defaultTtlMs: number,
  ) {}

  /** `undefined` means "not cached"; a cached `null` is a remembered miss. */
  get(key: string, now: number = Date.now()): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= now) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert so Map order tracks recency.
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number = this.defaultTtlMs, now: number = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: now + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Rounds a coordinate so nearby points share a cache entry. 3 dp ≈ 110 m. */
export function roundCoord(n: number, dp: number): string {
  return n.toFixed(dp);
}

export function normalizePlaceText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}
