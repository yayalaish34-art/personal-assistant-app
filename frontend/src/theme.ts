// Central design tokens so screens stay visually consistent.
//
// The look: an almost-white paper background, white cards, and flat pastel
// tiles — sage green, powder blue, butter yellow — with near-black type and
// near-black controls. No gradients, no glass: colour comes from the tiles,
// hierarchy from weight and size.

export const colors = {
  /** The page itself. Warm off-white, not pure white, so cards can be white. */
  bg: '#FBFBF9',
  surface: '#FFFFFF',
  /** Quiet fill for segmented controls and inactive chips. */
  surfaceAlt: '#F2F2EF',
  /** Near-black: type, active chips, the selected tab. */
  primary: '#14150F',
  primaryText: '#FFFFFF',
  text: '#14150F',
  textMuted: '#8C8D86',
  border: 'rgba(20, 21, 15, 0.07)',
  danger: '#E5484D',
  success: '#5F9B3C',
  /** Filled favourite star. */
  star: '#F0A32B',
  /** The unread dot on the bell. */
  alert: '#F4753A',
  lime: '#DCE8C0',
};

// ── The day card ──────────────────────────────────────────────────────────
// The one big surface on the home screen. It changes with the sky rather than
// staying one colour all day: a pale morning blue, and a dusk that is still
// light enough to keep near-black type on it, because the app has no dark
// surface anywhere else and one would read as a mistake.
export const DAY_CARD = {
  day: {
    colors: ['#CFE1F2', '#E8F1FA'] as const,
    ink: '#14150F',
    sub: 'rgba(20, 21, 15, 0.62)',
    glyph: '#4E82B4',
  },
  night: {
    colors: ['#D5D8EA', '#ECEDF5'] as const,
    ink: '#14150F',
    sub: 'rgba(20, 21, 15, 0.62)',
    glyph: '#5F6796',
  },
} as const;

/** The three pastel tiles everything is built from, plus a neutral. */
export const TILES = {
  green: '#DCE8C0',
  blue: '#CFE1F2',
  yellow: '#FAE0A0',
  neutral: '#F2F2EF',
} as const;

export type TileColor = keyof typeof TILES;

/** Ink that reads on each tile — used for icons and secondary marks. */
export const TILE_INK = {
  green: '#6E9036',
  blue: '#4E82B4',
  yellow: '#CE9424',
  neutral: '#8C8D86',
} as const;

/** Task and event rows cycle through these, in this order. */
export const ROW_TILES: TileColor[] = ['green', 'blue', 'yellow'];

/**
 * The sweep — green, blue, yellow. It marks the *chosen* thing: the mic button
 * in the bar, the selected day on Home. Mid-tone on purpose, so near-black ink
 * stays readable on top of it, and ordered green→blue→yellow so the two ends
 * are the pair furthest apart in hue.
 */
export const IRIDESCENT = ['#A8D98C', '#8FC7FF', '#FFD98A'] as const;

/**
 * The palette, unpacked into surfaces and marks: green, blue, yellow.
 *
 * `tint` is the pale card ground, `ink` the mark that sits on it. The slots
 * keep neutral names rather than colour names — every screen refers to them,
 * and a slot called `green` is a promise the next repaint has to keep.
 *
 * The inks are validated, not eyeballed. As a categorical set they clear all
 * six checks: the lightness band, the chroma floor, adjacent-pair CVD
 * separation (worst pair ΔE 13.6 protan), the normal-vision floor, and 3:1
 * against the page.
 *
 * Two things that validation forced, and which are easy to undo by accident:
 *
 * The yellow is an amber (#B8860B), not the butter yellow it looks like it
 * should be. Anything lighter cannot reach 3:1 on a near-white page — the
 * previous butter yellow sat at 2.59:1 — so a lighter one would be a mark
 * some people simply cannot see. The *tint* is still buttery; only the ink
 * that has to be read is deepened.
 *
 * The green and the yellow are neighbours in hue, which is the pair red-blind
 * vision merges. They are separated by lightness rather than by hue, which is
 * why the green is this dark. Nudging either toward the other collapses them:
 * the palette this replaced sat at ΔE 5.8 for a protanope, well under the 8
 * floor, and two of its rows were genuinely indistinguishable.
 *
 * One rule survives from before: `yellow.ink` is never a status mark. Against
 * `colors.danger` it drops to ΔE 4.7 for a deuteranope, so a yellow
 * "scheduled" dot and a red "overdue" dot would be the same dot. Yellow
 * dresses surfaces; the status vocabulary is green, blue, muted grey and red.
 */
export const AURA = {
  green: { tint: '#DFF0D2', ink: '#2E6B24' },
  blue: { tint: '#DCEAF8', ink: '#3E86C4' },
  yellow: { tint: '#FAECC8', ink: '#B8860B' },
} as const;

export type AuraKey = keyof typeof AURA;

/** Rows and chips cycle through the gradient's stops, in its own order. */
export const AURA_CYCLE: AuraKey[] = ['green', 'blue', 'yellow'];

// ── The assistant, out loud ───────────────────────────────────────────────
// She gets a palette of her own — violet on lavender — and nothing else in the
// app does. That is the point: the rest of the app is a surface you fill in by
// hand, and she is the one place you talk to. Walking into a different colour
// says which of the two you are in without a word of explanation.
//
// The inks are the readable half of it: `ink` and `accent` both clear 4.5:1 on
// the page, and `meta` — the 11px timestamps, the smallest type on the screen
// — was deepened from the mockup's grey until it did too (4.8:1). A timestamp
// nobody can read is decoration pretending to be information.
export const VOICE = {
  /** The page, top to bottom: almost white, settling into lavender. */
  page: ['#FAF9FE', '#EFE9FB'] as const,
  /** Type on the page and inside bubbles. Near-black, with a violet cast. */
  ink: '#1D1A33',
  /** The mic, the ticks, the send glyph — everything that is *her*. */
  accent: '#6D45E0',
  /** The raised mic button's sphere, lit from the top-left. */
  accentGradient: ['#A98BF5', '#7C5CF0', '#5B36C7'] as const,
  /** What she says. */
  her: '#EAE3FA',
  /** What you said: white, floated off the page on a soft shadow. */
  me: '#FFFFFF',
  /** Timestamps and the delivered ticks' quieter half. */
  meta: '#726A96',
  /** The round chrome buttons in the header, and the composer's field. */
  chrome: '#FFFFFF',
  /** The breathing halo behind the orb, palest first. */
  halo: [
    'rgba(124, 92, 240, 0.035)',
    'rgba(124, 92, 240, 0.05)',
    'rgba(124, 92, 240, 0.065)',
    'rgba(124, 92, 240, 0.085)',
  ] as const,
  /** The sound she is listening to, drawn either side of the orb. */
  wave: '#9E7CEE',
  /** The dotted orbit and the motes riding it. */
  orbit: 'rgba(109, 69, 224, 0.28)',
} as const;

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
// — a tight one for contact and a wide one for height.
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

/** Kept as a two-stop "gradient" so existing call sites need no changes. */
export const ACCENT_GRADIENT = {
  colors: ['#14150F', '#14150F'] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
};

// Priority pill palette (task form + task cards), drawn from the same tiles.
export type Priority = 'Low' | 'Medium' | 'High';
export const PRIORITY_COLORS: Record<Priority, { color: string; bg: string }> = {
  Low: { color: TILE_INK.green, bg: TILES.green },
  Medium: { color: TILE_INK.yellow, bg: TILES.yellow },
  High: { color: '#C0483C', bg: '#F6D9D2' },
};

/** Extra bottom room on scroll content so it clears the bar *and* its raised +. */
export const TAB_BAR_CLEARANCE = 134;
