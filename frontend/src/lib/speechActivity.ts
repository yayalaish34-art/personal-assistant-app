/** Require consecutive voice-level samples so a single tap does not trigger a turn. */
export function createSpeechActivity(threshold = -35) {
  let consecutive = 0;
  let heardSpeech = false;
  let quietSince: number | null = null;
  return {
    sample(db: number, now: number) {
      if (!Number.isFinite(db)) return { heardSpeech, quietMs: 0 };
      if (db > threshold) {
        consecutive += 1;
        if (consecutive >= 2) heardSpeech = true;
        quietSince = null;
      } else {
        consecutive = 0;
        if (heardSpeech && quietSince === null) quietSince = now;
      }
      return { heardSpeech, quietMs: quietSince === null ? 0 : now - quietSince };
    },
  };
}
