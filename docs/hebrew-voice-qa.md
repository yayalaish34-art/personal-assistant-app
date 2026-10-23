# Hebrew and assistant fixes — 2026-10-19

Changes are local and uncommitted. Existing workspace edits were preserved.

## Behavior

- One language preference controls UI translations, navigation, modal direction,
  time/date formatting, transcription and replies. Existing Hebrew voice-only
  preferences migrate on startup. All English UI keys have Hebrew translations.
- The existing theme tokens and React Native controls are reused. Sun/moon buttons
  in the shared greeting header switch the entire app immediately and persist the
  choice. Settings drafts are saved before changing language or appearance.
- Both transcription endpoints share `speech/transcribe.ts`. The default is
  `gpt-4o-mini-transcribe`, with a Hebrew hint/context, a 25-second timeout and no
  paid retry/fallback. `OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe` is an explicit
  quality/cost override. No credentials were changed.
- Two consecutive voice-level samples are required to start a spoken turn.
  Pauses allow 1.6 seconds; recording resumes 0.6 seconds after playback to reduce
  echo. A real spoken farewell is retained; there is no blacklist of phrases.
- The assistant prompt asks for natural Hebrew, contextual spelling correction,
  clarification of ambiguous products, concise confirmations, and no unsolicited
  goodbye or invented financial details. `gpt-4.1-mini` remains the default voice
  reasoning model; temperature is 0.3 and output is capped at 2,000 tokens/round.
  Hebrew TTS explicitly supplies `language_code: he` to ElevenLabs.
- Five questions cover workdays, focus period, primary goal, sleep quality and
  assistance style. They are editable in Settings, persist on device, and reach
  every voice turn. Existing profiles receive safe defaults. Sleep guidance is
  general adult guidance rather than a sex-specific medical claim.
- Shopping estimates are disabled by default, labeled as estimates when enabled,
  and omitted for unrecognized products/currencies. Unknown items no longer get
  the default 15-shekel value. Checkout starts with an empty actual-payment field.
- Calendar statistics clip events to the selected dates, split hours across
  midnight, and count overlaps once (shared equally among concurrent events).
  The screen describes this as scheduled calendar time, not tracked activity.

## Cost and sources

Estimated transcription prices checked on 2026-10-19:

| Model | Per minute | 60 minutes |
| --- | --- | --- |
| gpt-4o-mini-transcribe | $0.003 | $0.18 |
| gpt-4o-transcribe | $0.006 | $0.36 |

These are transcription estimates only; LLM replies and ElevenLabs speech have
their own charges. No live paid API calls were used in automated tests.

- [OpenAI pricing](https://developers.openai.com/api/docs/pricing)
- [Mini transcriber capabilities](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)
- [ElevenLabs language enforcement](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)
- [NIH adult sleep guidance](https://www.nhlbi.nih.gov/health/heart-healthy-living/sleep)
- [NIH sleep routines](https://www.nhlbi.nih.gov/health/sleep-deprivation/healthy-sleep-habits)

## Verification

- Frontend and backend: TypeScript `--noEmit` passed.
- Eight focused Vitest suites: 179 passed, 2 skipped. Covers language migration,
  Hebrew dictionary/placeholder completeness, theme persistence, profile defaults,
  silence/noise gating, unknown prices, overlapping/overnight calendar events,
  mocked transcription and the agent tool loop, plus existing voice/availability/
  reminders/prompt/image validation tests. Database suites were not run.
- Fixed the existing slot tests to use their fixture clock, rather than failing
  simply because August 2026 is now in the past.
- `git diff --check` passed.
- Expo web production export passed (2,519 modules); generated output is in
  `.qa/web`, which is ignored by Git. This verifies bundling, not native layout.
- 21st CLI was unavailable; implementation uses the project's existing React
  Native primitives and palettes. No replacement web components were introduced.

## Deployment — 2026-10-19, verified 2026-10-20

- Railway production deployment `5293a13e-dfe4-4185-bd8c-f9c18ddd7412` reached
  `SUCCESS`. `/health` returned `200` with `status: ok`. The empty Hebrew voice
  turn returned the localized retry prompt and accepted the new profile fields.
- A live text turn, “תוסיפי מיץ ענבים לרשימת הקניות”, returned one
  `add_shopping_item` action with `name: מיץ ענבים`, no price, and a natural
  Hebrew confirmation. This stateless smoke test did not modify user data.
- EAS iOS production build `c757f0d6-70c9-47c0-9eef-9a443c2a0d1a` finished:
  version **1.0.0 (4)**. Submission `8578ee96-473c-4401-9468-d23b10465d73`
  finished. App Store Connect reports `VALID` / `IN_BETA_TESTING` for internal
  testers; external state is `READY_FOR_BETA_SUBMISSION`.
- Both uploads included the local uncommitted application changes. Added
  `.easignore` and `backend/.railwayignore` to exclude local credentials,
  recordings and unrelated files from the respective upload archives.
  `frontend/eas.json` now records the existing App Store Connect app ID for
  repeatable non-interactive submissions. No new distribution target was created.
- **Initial service blocker (resolved below):** ElevenLabs returned `401 / quota_exceeded`.
  Its error reports only **3 credits remaining** (one observed request required
  67). Direct speech generation fails; a prewarmed request can return an empty
  audio response. No plan upgrade or purchase was made.
- On 2026-10-20, the user supplied a replacement ElevenLabs API key. Updated
  `backend/.env` and the Railway production variable; verified they match without
  logging either value. Deployment `797f3b52-0c70-49e7-9514-b8c95dd8dbe5` reached
  `SUCCESS`; health returned `ok`. A live Hebrew speech request returned HTTP 200,
  `audio/mpeg`, and 9,553 bytes. The provider quota blocker is resolved for the
  replacement key. No mobile rebuild was needed.
- No physical-device layout/listening test was performed. A successful upload
  does not establish Hebrew pronunciation quality. The code remains uncommitted.

## Device verification

Automated mocks do not establish real Hebrew recognition or pronunciation quality.
Install TestFlight version 1.0.0 (4); the replacement speech key is active on the server.

1. The production build uses the existing Railway API by default. For local
   development, set `EXPO_PUBLIC_API_URL` (see `frontend/.env.example`); on a
   phone use the computer's LAN address, not localhost.
2. Select Hebrew from an English install and restart. Check Home, Calendar,
   Shopping, Finance, Settings, onboarding and edit/export modals for Hebrew/RTL.
3. Toggle day/night from the header and Settings; restart and check persistence.
4. Say “תוסיפי מיץ ענבים לרשימת הקניות”, pause mid-sentence, and try quiet speech.
   Verify the exact product name, one item, no invented price/expense, and a short
   natural confirmation. Listen for accent, grammar and word endings.
5. Leave the microphone in silence, tap nearby, then say a real goodbye. Silence
   must not cause a fabricated conversation ending; the real goodbye must survive.
6. Answer/edit all five questions and request a suitable plan. Preferences are
   guidance, while existing sleep/buffer constraints are enforced by scheduling.
7. Check adjacent, overlapping and overnight events in the time statistics.
8. Stored user text and existing demo entries retain their original language;
   selecting Hebrew does not rewrite saved personal data.
