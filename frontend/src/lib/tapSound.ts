// The one bit of UI sound in an otherwise silent app: a soft blip when the
// mic button is pressed, so pressing it reads as "she's listening now"
// before the screen even opens.
//
// Loaded the same lazy, guarded way as the voice session's own player: builds
// without the native `expo-audio` module must not crash on import, they
// should just skip the sound.

type AudioApi = typeof import('expo-audio');

type Player = {
  play: () => void;
  seekTo: (seconds: number) => Promise<void>;
  remove: () => void;
};

let cachedAudio: AudioApi | null | undefined;
function getAudio(): AudioApi | null {
  if (cachedAudio !== undefined) return cachedAudio;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedAudio = require('expo-audio') as AudioApi;
  } catch {
    cachedAudio = null;
  }
  return cachedAudio;
}

let player: Player | null | undefined;

/** Plays the mic-tap blip. Does nothing where audio isn't available. */
export function playTapSound(): void {
  const audio = getAudio();
  if (!audio) return;
  try {
    if (player === undefined) {
      player = (
        audio as unknown as { createAudioPlayer: (source: number) => Player }
      ).createAudioPlayer(require('../../assets/sounds/mic-tap.wav'));
    }
    if (!player) return;
    // Rewind first so a second tap before the blip finishes still restarts it.
    void player.seekTo(0).finally(() => player?.play());
  } catch {
    player = null;
  }
}
