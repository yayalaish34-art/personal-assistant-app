// Central design tokens.
//
// Two complete palettes, switchable at runtime (see lib/theme.tsx):
//
//   dark  — the reference design: near-black ground, orange accent, and cards
//           that carry colour as meaning (a lime priority card, a magenta
//           progress arc, a gradient AI panel).
//   light — the original lilac/peach gradient treatment.
//
// StyleSheet.create runs at module scope and cannot read runtime state, so a
// screen cannot simply reference `palette.text` inside a static stylesheet.
// The pattern throughout is:
//
//   const { palette: c } = useTheme();
//   const styles = useMemo(() => makeStyles(c), [c]);
//
// Structural values (spacing, radii, font) are theme-independent and stay in
// module-scope stylesheets.

export type ThemeMode = 'light' | 'dark';

export type Palette = {
  mode: ThemeMode;

  /** Page ground. */
  bg: string;
  /** Raised card on the ground. */
  surface: string;
  /** A nested or secondary surface inside a card. */
  surfaceAlt: string;
  /** Hairline dividers and card edges. */
  border: string;

  text: string;
  textMuted: string;
  /** Text that sits on `primary` or on a saturated accent fill. */
  onAccent: string;
  /** Text that sits on a light accent fill (the lime card). */
  onLight: string;

  /** The single accent: the FAB, the active tab, primary buttons. */
  primary: string;
  primaryPressed: string;

  // ── Semantic accents ──
  // In the reference these are content, not decoration: priority level,
  // meeting provider, chart series. Kept separate from `primary` so a chart
  // never accidentally reads as a call to action.
  lime: string;
  cyan: string;
  pink: string;
  lavender: string;

  danger: string;
  success: string;

  /** Elevation shadow, tuned per theme — a dark ground needs a darker cast. */
  shadow: string;
  shadowOpacity: number;
};

export const DARK: Palette = {
  mode: 'dark',
  bg: '#0A0A0B',
  surface: '#1A1A1C',
  surfaceAlt: '#252528',
  border: 'rgba(255,255,255,0.08)',
  text: '#FFFFFF',
  textMuted: '#8A8A8E',
  onAccent: '#FFFFFF',
  onLight: '#0A0A0B',
  primary: '#FF6B35',
  primaryPressed: '#E85A28',
  lime: '#B4E33D',
  cyan: '#2DD4BF',
  pink: '#EC4899',
  lavender: '#A5B4FC',
  danger: '#F0616B',
  success: '#4ADE80',
  shadow: '#000000',
  shadowOpacity: 0.5,
};

export const LIGHT: Palette = {
  mode: 'light',
  bg: '#F8F0E8',
  surface: '#FFFFFF',
  surfaceAlt: '#F2ECFA',
  border: 'rgba(25,23,33,0.06)',
  text: '#191721',
  textMuted: '#8E8B96',
  onAccent: '#FFFFFF',
  onLight: '#191721',
  primary: '#FF6B35',
  primaryPressed: '#E85A28',
  lime: '#B4E33D',
  cyan: '#14B8A6',
  pink: '#EC4899',
  lavender: '#8B7FF0',
  danger: '#E5484D',
  success: '#3EA06B',
  shadow: '#3F2E64',
  shadowOpacity: 0.1,
};

export const PALETTES: Record<ThemeMode, Palette> = { light: LIGHT, dark: DARK };

/**
 * Backwards-compatible alias for screens not yet migrated to `useTheme()`.
 * Points at the dark palette, which is the design being matched — an
 * unmigrated screen therefore still reads correctly rather than rendering
 * light-on-light.
 */
export const colors = DARK;

// ── Structure (theme-independent) ─────────────────────────────────────────

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
};

export const radius = {
  sm: 12,
  md: 16,
  /** Card radius in the reference. */
  lg: 20,
  /** Fully rounded pills and chips. */
  pill: 50,
};

// ── Typography ────────────────────────────────────────────────────────────
// Urbanist is a geometric sans with a low-contrast, rounded feel. React Native
// cannot synthesize weights for custom fonts, so each weight is its own
// family and `fontWeight` alone does nothing. Use `font(weight)`, always.
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

// ── Card recipe ───────────────────────────────────────────────────────────
// Shared so every screen produces the same card, rather than each one
// re-deciding radius, padding, and elevation.
export function cardStyle(c: Palette) {
  return {
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    padding: spacing.md + 2,
    borderWidth: c.mode === 'dark' ? 0 : 1,
    borderColor: c.border,
    shadowColor: c.shadow,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: c.shadowOpacity,
    shadowRadius: 16,
    elevation: 4,
  } as const;
}

/** Small status/priority chip: coloured fill, dark text. */
export function chipStyle() {
  return {
    borderRadius: radius.pill,
    paddingHorizontal: 11,
    paddingVertical: 5,
    alignSelf: 'flex-start',
  } as const;
}

// ── Background ────────────────────────────────────────────────────────────
// The dark theme is a flat ground: the reference has no gradient wash, and a
// bloom over near-black reads as a smudge. The light theme keeps the original
// multi-bloom treatment.

export const GRADIENT_BACKGROUND = {
  colors: ['#F7E9EC', '#F1E4F3', '#E9E4F6', '#E6E3F3', '#EDEAF5'] as const,
  locations: [0, 0.22, 0.5, 0.78, 1] as const,
  start: { x: 0.1, y: 0 },
  end: { x: 0.9, y: 1 },
};

// Radial colour blooms layered over the light base ramp. `size` is a fraction
// of screen width; x/y are fractions of the screen box.
export const BACKGROUND_BLOOMS = [
  { color: '#F9C9A8', x: -0.05, y: -0.02, size: 0.95, opacity: 0.62 },
  { color: '#D9A2E8', x: 0.52, y: -0.06, size: 1.05, opacity: 0.7 },
  { color: '#F2A7C3', x: 0.2, y: 0.06, size: 0.8, opacity: 0.4 },
  { color: '#B9B3F2', x: 0.3, y: 0.3, size: 1.15, opacity: 0.34 },
  { color: '#CFC6F0', x: -0.15, y: 0.55, size: 1.0, opacity: 0.4 },
  { color: '#EAD3E4', x: 0.55, y: 0.72, size: 0.9, opacity: 0.34 },
] as const;

// ── Bottom navigation ─────────────────────────────────────────────────────
// The reference bar is flat — no pill, no card. Four icons, and a large
// circular accent button overlapping the bar's top edge.
export function navBar(c: Palette) {
  return {
    background: c.mode === 'dark' ? '#000000' : '#FFFFFF',
    activeIcon: c.primary,
    inactiveIcon: c.mode === 'dark' ? '#5A5A5E' : '#9A96A8',
    fabFill: c.primary,
    fabIcon: '#FFFFFF',
  };
}

/** Static form used by code that cannot call a hook. */
export const NAV_BAR = navBar(DARK);

/** Accent gradient for primary buttons and the FAB. */
export const ACCENT_GRADIENT = {
  colors: ['#FF8355', '#FF5A1F'] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
};

/** The warm gradient behind the AI analysis panel in the reference. */
export const AI_GRADIENT = {
  colors: ['#FFB88C', '#F890A8', '#C99BE8'] as const,
  locations: [0, 0.5, 1] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
};

// ── Priority ──────────────────────────────────────────────────────────────
// In the reference High is magenta and Low is lime, both as solid fills with
// dark text rather than the tinted-background pills of the old design.
export type Priority = 'Low' | 'Medium' | 'High';

export function priorityColors(c: Palette): Record<Priority, { color: string; bg: string }> {
  return {
    Low: { color: c.onLight, bg: c.lime },
    Medium: { color: c.onAccent, bg: '#F59E0B' },
    High: { color: c.onAccent, bg: c.pink },
  };
}

/** Static form for module-scope use. */
export const PRIORITY_COLORS = priorityColors(DARK);

// Extra bottom room on scroll content so it clears the floating tab bar.
export const TAB_BAR_CLEARANCE = 110;
