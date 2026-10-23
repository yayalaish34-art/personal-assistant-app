// Central design tokens so screens stay visually consistent.
//
// The look, everywhere: a page lit by a faint blue glow, cards a step off it
// with a hairline edge, type in two weights, and a few lit colours that mean
// something — the app's blue for the chosen thing, the green-blue-yellow sweep
// for the one word a headline leans on, and lit discs behind the icons that
// label a count. Hierarchy comes from size and weight; colour is kept for
// meaning.
//
// It comes in two schemes, dark and light, chosen in Settings. Every token
// below is a live object that `applyScheme` rewrites in place, the same way
// `t()` reads the current language: a screen that reads `colors.text` at
// render gets the scheme in force, and the app remounts its tree when the
// scheme changes (see App.tsx). Styles built once at import would keep the
// scheme they were built in, so every StyleSheet is wrapped in `themed`, which
// rebuilds it the first time it is read after a change.

export type Scheme = 'dark' | 'light';

type Pair = readonly [string, string];
type Triple = readonly [string, string, string];

// ── The two palettes ──────────────────────────────────────────────────────

/**
 * The page's names for things.
 *
 * Dark: `text` 16.9:1 and `textMuted` 7:1 on `surface`. Light: `text` 18:1 and
 * `textMuted` 6.2:1 on white, 5.6:1 on `surfaceAlt`; `danger` is deepened to
 * 4.7:1 because the dark scheme's coral is 2.9:1 on white.
 */
const COLORS = {
  dark: {
    /** The page. Blue-black: `Screen` draws the glow over it. */
    bg: '#05080E',
    /** Cards, sheets, fields. Opaque, so a sheet over a backdrop stays solid. */
    surface: '#0F141C',
    /** Quiet fill for segmented controls, inactive chips, a field's ground. */
    surfaceAlt: '#171D28',
    /** The chosen thing and the primary button. White on it clears 4.5:1. */
    primary: '#2A6FE0',
    primaryText: '#FFFFFF',
    text: '#F5F7FA',
    textMuted: '#9AA3B2',
    border: 'rgba(255, 255, 255, 0.08)',
    danger: '#FF6B6B',
    success: '#6EE7A8',
    /** Filled favourite star. */
    star: '#FFD24D',
    /** The unread dot on the bell. */
    alert: '#FF6A2B',
    lime: 'rgba(110, 231, 168, 0.14)',
  },
  light: {
    bg: '#FFFFFF',
    surface: '#FFFFFF',
    surfaceAlt: '#F1F4F9',
    primary: '#2A6FE0',
    primaryText: '#FFFFFF',
    text: '#0B1220',
    textMuted: '#5B6576',
    border: 'rgba(11, 18, 32, 0.09)',
    danger: '#D64545',
    success: '#1E9E5A',
    star: '#B8860B',
    alert: '#F4753A',
    lime: 'rgba(30, 158, 90, 0.12)',
  },
};

/**
 * The sweep — green, blue, yellow. It marks the *chosen* thing: the mic button
 * in the bar, the selected tab. Mid-tone on purpose, so dark ink stays
 * readable on top of it in both schemes; it is a fill, never type.
 */
const SWEEP: Triple = ['#A8D98C', '#8FC7FF', '#FFD98A'];

/**
 * The sweep in reading order — blue into green into yellow — for the one word
 * a headline is painted with: "Planzi" on Home.
 *
 * This one *is* type, so on white it is deepened: the dark scheme's butter
 * yellow is 1.4:1 on white and the word's last letters would simply vanish.
 * Every stop of the light version holds 3:1 at headline size.
 */
const SWEEP_WORD: Record<Scheme, Triple> = {
  dark: [SWEEP[1], SWEEP[0], SWEEP[2]],
  light: ['#2F7FE6', '#1E9E5A', '#C28400'],
};

/**
 * The palette, unpacked into surfaces and marks: green, blue, yellow.
 *
 * `tint` is a card ground — the hue at a whisper over the page — and `ink` the
 * mark that sits on it or on the page. Type on a tint is `colors.text`, never
 * the ink. The slots keep neutral names rather than colour names: every screen
 * refers to them, and a slot called `green` is a promise a repaint has to keep.
 *
 * Every ink clears 3:1 against its page. Green and yellow are neighbours in
 * hue — the pair red-blind vision merges — so they are held apart by
 * lightness: the green is the darker of the two by a clear step, in both
 * schemes. The light inks are the ones the app was validated with when it was
 * a light app (worst adjacent pair ΔE 13.6 for a protanope).
 *
 * One rule holds in both: `yellow.ink` is never a status mark. Beside
 * `colors.danger` it is too close for a deuteranope, so a yellow "scheduled"
 * dot and a red "overdue" dot would be the same dot. Yellow dresses surfaces;
 * the status vocabulary is green, blue, muted grey and red.
 */
const AURAS = {
  dark: {
    green: { tint: 'rgba(63, 191, 127, 0.14)', ink: '#3FBF7F' },
    blue: { tint: 'rgba(77, 166, 255, 0.14)', ink: '#6AB4FF' },
    yellow: { tint: 'rgba(255, 210, 77, 0.13)', ink: '#FFD24D' },
  },
  light: {
    green: { tint: 'rgba(46, 107, 36, 0.10)', ink: '#2E6B24' },
    blue: { tint: 'rgba(62, 134, 196, 0.12)', ink: '#3E86C4' },
    yellow: { tint: 'rgba(232, 170, 20, 0.15)', ink: '#B8860B' },
  },
};

/**
 * Home's lit pieces, shared by every screen with something of the same kind:
 * the glass cards, the blue selection, the discs, the row edges.
 *
 * Cards are translucent over the page rather than a fixed grey, so the glow
 * behind them shows through. On white that means a whisper of ink rather than
 * of white; the edge does the rest.
 *
 * On white the lit marks are deepened where they are marks: the "now" line,
 * a task's edge and the sun glyph each hold 3:1, and the timeline's blocks are
 * a step more saturated so a pale cyan block does not disappear into its card.
 * The discs and the blue stay as they are — dark glyphs and white type sit on
 * them the same on either page.
 */
const NIGHTS = {
  dark: {
    /** The page. Blue-black, not warm: the glow over it is blue. */
    bg: '#05080E',
    /** Cards, rows, the day rail: white at a whisper over the page. */
    card: 'rgba(255, 255, 255, 0.045)',
    /** A quieter fill inside a card, and the bell's disc. */
    cardAlt: 'rgba(255, 255, 255, 0.08)',
    /** Type. */
    ink: '#F5F7FA',
    /** Second lines, timestamps, weekday letters. */
    sub: '#9AA3B2',
    /** Hairlines: card edges and the dividers inside the rails. */
    line: 'rgba(255, 255, 255, 0.08)',
    /** The glow behind the head of the page. */
    glow: '#2B4F80',
    /** The chosen day, and the accent on a meeting's row. */
    blue: ['#4DA6FF', '#2D78F0'] as Pair,
    /** The "now" line on the timeline. */
    now: '#6FD6FF',
    /** The accent on a task's row. */
    green: '#6EE7A8',
    /** Sun glyphs in the forecast. */
    sun: '#FFD24D',
    /** Unread dot on the bell. */
    alert: '#FF6A2B',
    /** Blocks on the timeline, cycled in clock order. */
    blocks: [
      ['#9BEAFF', '#5CC6F2'],
      ['#FFE7A0', '#F7CD62'],
      ['#6AA6FF', '#3F7CF0'],
    ] as readonly Pair[],
    /** The lit discs behind the counts; the tasks one also fills a ticked row. */
    discs: {
      tasks: ['#C4E8FF', '#5EAEF6'] as Pair,
      meetings: ['#FFEBB5', '#F4BE5E'] as Pair,
      reminders: ['#E2F3FF', '#94CDF6'] as Pair,
    },
    /** Glyphs sitting on a lit disc: near-black with a blue cast. */
    glyph: '#0C1726',
    /** The ring of a tick that is not ticked yet. */
    tickRing: '#7D8696',
    /** The handle at the top of a sheet. */
    grip: 'rgba(255, 255, 255, 0.18)',
    /** What dims the page behind a sheet or a dialog. */
    backdrop: 'rgba(0, 0, 0, 0.55)',
    /** A light catching glass as it passes: the shimmer on a pill. */
    sheen: 'rgba(255, 255, 255, 0.12)',
    /**
     * The card across the foot of Home, which the nav bar sits on.
     *
     * Light in both schemes — it is the one pale surface on the dark, which is
     * what makes it and the white bar read as one footer. Off-white rather
     * than white: on the dark, white at full strength glares.
     */
    foot: '#EDF1F7',
    footInk: '#0B1220',
    footSub: '#5B6576',
  },
  light: {
    bg: '#FFFFFF',
    card: 'rgba(11, 18, 32, 0.045)',
    cardAlt: 'rgba(11, 18, 32, 0.07)',
    ink: '#0B1220',
    sub: '#5B6576',
    line: 'rgba(11, 18, 32, 0.1)',
    /** Paler than the dark one: on white a strong pool reads as a blue page. */
    glow: '#D3E4FD',
    blue: ['#4DA6FF', '#2D78F0'] as Pair,
    now: '#1590CF',
    green: '#1E9E5A',
    sun: '#B8860B',
    alert: '#F4753A',
    blocks: [
      ['#6FD3F7', '#2FB2E6'],
      ['#FFD470', '#F2B53A'],
      ['#5B9BFF', '#2F6FE8'],
    ] as readonly Pair[],
    discs: {
      tasks: ['#BFE3FF', '#4EA2F2'] as Pair,
      meetings: ['#FFE6A8', '#F2B544'] as Pair,
      reminders: ['#DAEFFF', '#80BFF2'] as Pair,
    },
    glyph: '#0C1726',
    tickRing: '#A3ACB9',
    grip: 'rgba(11, 18, 32, 0.16)',
    backdrop: 'rgba(11, 18, 32, 0.35)',
    sheen: 'rgba(255, 255, 255, 0.7)',
    /** On white the foot is a step *down*, not up: its edge does the rest. */
    foot: '#E4E9F2',
    footInk: '#0B1220',
    footSub: '#5B6576',
  },
};

/**
 * The assistant's names for the shared palette, plus the three things only she
 * has: the halo, the wave and the orbit.
 *
 * She was once violet on lavender, so that walking in said "this is where you
 * talk to her". She wears the app's scheme now like every other screen, and
 * what sets her apart is what only she has — the lit orb, the sound either
 * side of it, the ring turning — rather than a different ground under it.
 *
 * In the dark the inks were checked under the brightest point of the glow,
 * where her bubbles sit in Hebrew: `meta`, the 11px timestamps, clears 4.5:1
 * there (4.6:1), which is why her bubble is a card's whisper and not more, and
 * `accent` is the cyan because the blue falls to 3.6:1 on a time row under the
 * glow. On white the cyan is the deepened one from `NIGHTS.light`.
 */
function voiceFor(s: Scheme) {
  const c = COLORS[s];
  const n = NIGHTS[s];
  return {
    /** The page, top to bottom, a shade bluer by the composer. */
    page: (s === 'dark' ? [c.bg, '#0A1220'] : [c.bg, '#EEF4FF']) as Pair,
    /** Type on the page and in her bubbles. */
    ink: c.text,
    /** Her marks: undo, restart, a time's weekday, the spinner, the send glyph at rest. */
    accent: n.now,
    /**
     * The orb. The sweep the mic button in the bar is made of, so the button
     * you pressed to open her is the thing you are now talking to. Glyphs on
     * it are `NIGHT.glyph`.
     */
    accentGradient: SWEEP,
    /** What she says: glass, like a card on Home, with a hairline edge. */
    her: n.card,
    /** What you said: the app's blue, with white on it (4.7:1). */
    me: c.primary,
    /** Timestamps on her lines, the hint under the caption, the placeholder. */
    meta: c.textMuted,
    /** Glass discs and pills: the header buttons, the undo bar, a time to pick. */
    chrome: n.cardAlt,
    /** The breathing halo behind the orb, palest (and widest) first. */
    halo: (s === 'dark'
      ? ['rgba(77, 166, 255, 0.04)', 'rgba(77, 166, 255, 0.06)', 'rgba(77, 166, 255, 0.08)', 'rgba(77, 166, 255, 0.1)']
      : ['rgba(47, 127, 230, 0.05)', 'rgba(47, 127, 230, 0.07)', 'rgba(47, 127, 230, 0.09)', 'rgba(47, 127, 230, 0.12)']) as readonly [
      string,
      string,
      string,
      string,
    ],
    /** The sound she is listening to, drawn either side of the orb. */
    wave: n.now,
    /** The dotted orbit and the motes riding it. */
    orbit: s === 'dark' ? 'rgba(111, 214, 255, 0.3)' : 'rgba(21, 144, 207, 0.3)',
  };
}

// Priority pill palette (task form + task cards), drawn from the same palette.
export type Priority = 'Low' | 'Medium' | 'High';
function prioritiesFor(s: Scheme): Record<Priority, { color: string; bg: string }> {
  return {
    Low: { color: AURAS[s].green.ink, bg: AURAS[s].green.tint },
    Medium: { color: AURAS[s].yellow.ink, bg: AURAS[s].yellow.tint },
    High: {
      color: COLORS[s].danger,
      bg: s === 'dark' ? 'rgba(255, 107, 107, 0.14)' : 'rgba(214, 69, 69, 0.10)',
    },
  };
}

// ── The live tokens ───────────────────────────────────────────────────────
// What every screen imports. They start dark and are rewritten in place by
// `applyScheme`; nothing may hold on to a value read from them across a change.

export const colors = { ...COLORS.dark };
export const IRIDESCENT = SWEEP;
export const SWEEP_TEXT: Triple = [...SWEEP_WORD.dark];
export const AURA = { ...AURAS.dark };
export type AuraKey = keyof typeof AURA;
export const NIGHT = { ...NIGHTS.dark };
export const VOICE = voiceFor('dark');
export const PRIORITY_COLORS = prioritiesFor('dark');

/** Rows and chips cycle through the gradient's stops, in its own order. */
export const AURA_CYCLE: AuraKey[] = ['green', 'blue', 'yellow'];

let scheme: Scheme = 'dark';
/** Bumps on every change, so `themed` knows its sheet is stale. */
let schemeVersion = 0;

/** The scheme in force. */
export function currentScheme(): Scheme {
  return scheme;
}

/**
 * Rewrites every live token for `next`. The caller remounts whatever is on
 * screen; `lib/appearance.ts` does both, and saves the choice.
 */
export function applyScheme(next: Scheme): void {
  if (next === scheme) return;
  scheme = next;
  Object.assign(colors, COLORS[next]);
  (SWEEP_TEXT as unknown as string[]).splice(0, 3, ...SWEEP_WORD[next]);
  Object.assign(AURA, AURAS[next]);
  Object.assign(NIGHT, NIGHTS[next]);
  Object.assign(VOICE, voiceFor(next));
  Object.assign(PRIORITY_COLORS, prioritiesFor(next));
  schemeVersion += 1;
}

/**
 * A StyleSheet that follows the scheme.
 *
 * `StyleSheet.create` is evaluated once, at import, and bakes in whatever the
 * tokens held then. Wrap it — `const styles = themed(() => StyleSheet.create({…}))`
 * — and it is rebuilt the first time a style is read after the scheme changes,
 * so the remounted screen gets the new colours. Anything else a module builds
 * from tokens at import (a shared `glass` object, a table of colours) has to
 * be built inside the factory or at render for the same reason.
 */
export function themed<T extends object>(make: () => T): T {
  let sheet: T | undefined;
  let builtFor = -1;
  return new Proxy({} as T, {
    get(_, key) {
      if (builtFor !== schemeVersion || sheet === undefined) {
        sheet = make();
        builtFor = schemeVersion;
      }
      return (sheet as Record<string | symbol, unknown>)[key];
    },
  });
}

// ── Scheme-free tokens ────────────────────────────────────────────────────

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 14,
  md: 20,
  lg: 26,
};

// ── Typography ────────────────────────────────────────────────────────────
// Urbanist is a geometric sans with a low-contrast, rounded feel. React Native
// can't synthesize weights for custom fonts, so each weight is its own family
// and `fontWeight` alone does nothing. Use `font(weight)` instead of
// `fontWeight`, always.
export const fonts = {
  400: 'Urbanist_400Regular',
  500: 'Urbanist_500Medium',
  600: 'Urbanist_600SemiBold',
  700: 'Urbanist_700Bold',
} as const;

export type FontWeight = keyof typeof fonts;

/** Style fragment for a given Urbanist weight. Spread it: `...font(600)`. */
export function font(weight: FontWeight = 400) {
  return { fontFamily: fonts[weight] } as const;
}

// ── Bottom navigation bar ─────────────────────────────────────────────────
// A pane of glass hovering over the page: translucent, so what's behind it
// ghosts through, lit along its top edge, and floating on two stacked shadows
// — a tight one for contact and a wide one for height. White in both schemes:
// on the dark it is the one light surface, which is what makes it read as the
// app's chrome; on white its shadows lift it off the page.
export const NAV_BAR = {
  /** Panel fill, top to bottom. Not opaque: the page shows through. */
  glassTop: 'rgba(255, 255, 255, 0.95)',
  glassBottom: 'rgba(250, 250, 246, 0.80)',
  /** Hairline around the outline — the only thing that survives on any backdrop. */
  edge: 'rgba(20, 21, 15, 0.07)',
  /** Light catching the top edge, strongest around the scoop. */
  rim: 'rgba(255, 255, 255, 0.95)',
  /** Contact shadow (tight) and cast shadow (wide, further down). */
  shadowNear: 'rgba(20, 21, 15, 0.13)',
  shadowFar: 'rgba(20, 21, 15, 0.15)',
  /** The raised + in the middle, and the tab you're on. */
  accent: '#F4753A',
  /** Lit from the top-left, so the button reads as a sphere rather than a disc. */
  accentGradient: ['#FFA469', '#F4753A', '#E15C25'] as const,
  accentIcon: '#FFFFFF',
  activeIcon: '#F4753A',
  /** Faint accent inside the active glyph, so it reads filled but stays legible. */
  activeWash: 'rgba(244, 117, 58, 0.16)',
  /** The disc behind the selected glyph — shape carrying what colour alone did. */
  activeSurface: 'rgba(244, 117, 58, 0.10)',
  inactiveIcon: '#9A9A93',
};

/** Extra bottom room on scroll content so it clears the bar *and* its raised +. */
export const TAB_BAR_CLEARANCE = 134;
