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
// A flat white bar. The active tab is a filled black circle; everything else
// is a plain outline icon.
export const NAV_BAR = {
  background: '#FFFFFF',
  activeFill: '#14150F',
  activeIcon: '#FFFFFF',
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

/** Extra bottom room on scroll content so it clears the floating tab bar. */
export const TAB_BAR_CLEARANCE = 108;
