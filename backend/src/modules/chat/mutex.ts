/**
 * Per-user in-memory mutex.
 *
 * Guarantees serial execution of `POST /chat/message` calls for a given user
 * (CLAUDE.md §8 concurrency invariant). If two requests race, the second
 * awaits the first — no parallel tool_calls on the same user's resources.
 *
 * MVP-scale trade-off: process-local. If the backend ever runs multiple
 * replicas this needs to move to Postgres advisory locks or Redis.
 */

const chain = new Map<string, Promise<unknown>>();

export async function withUserLock<T>(
  userId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chain.get(userId) ?? Promise.resolve();
  // Continue whether prev resolved or rejected — one request's failure must
  // not indefinitely block the next.
  const current: Promise<T> = prev.then(fn, fn);
  chain.set(userId, current);
  try {
    return await current;
  } finally {
    // If we're still the tail, drop the entry so the Map doesn't leak.
    if (chain.get(userId) === current) {
      chain.delete(userId);
    }
  }
}
