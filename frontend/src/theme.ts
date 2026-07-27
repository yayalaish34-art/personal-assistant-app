// Central design tokens so screens stay visually consistent.
// "Productive" task-app design: lilac→peach→cream gradient background,
// solid white rounded cards, periwinkle-purple accent, lime highlights.
export const colors = {
  // Flat fallback for anything rendered before/behind the gradient.
  bg: '#F8F0E8',
  // Solid white cards on the gradient.
  surface: '#FFFFFF',
  surfaceAlt: '#F2ECFA',
  // Periwinkle purple (the "+" button / Create Task button in the mockup).
  primary: '#8875F6',
  primaryText: '#FFFFFF',
  text: '#191721',
  textMuted: '#8E8B96',
  border: 'rgba(25, 23, 33, 0.06)',
  danger: '#E5484D',
  success: '#3EA06B',
  lime: '#D5E97E',
};

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
  lg: 28,
};

// ── Typography ────────────────────────────────────────────────────────────
// Urbanist is a geometric sans with a low-contrast, rounded feel — the font
// used for the headline and nav labels in the reference design. React Native
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

// ── Background ────────────────────────────────────────────────────────────
// The reference background is not one linear ramp — it's several distinct
// color blooms bleeding into each other: warm peach top-left, a saturated
// lilac/orchid top-right, cooling through pale periwinkle mid-screen, and
// settling into soft lavender-grey at the bottom. `Screen` renders this as a
// base ramp plus overlapping radial blooms (see components/ui.tsx).

// Base vertical ramp: the overall light-to-lavender fall-off.
export const GRADIENT_BACKGROUND = {
  colors: ['#F7E9EC', '#F1E4F3', '#E9E4F6', '#E6E3F3', '#EDEAF5'] as const,
  locations: [0, 0.22, 0.5, 0.78, 1] as const,
  start: { x: 0.1, y: 0 },
  end: { x: 0.9, y: 1 },
};

// Radial color blooms layered over the base ramp. Each is a soft-edged circle
// of one hue; together they produce the multi-color wash of the mockup.
// `size` is a fraction of screen width; x/y are fractions of the screen box.
export const BACKGROUND_BLOOMS = [
  // Warm peach behind the avatar / greeting, top-left.
  { color: '#F9C9A8', x: -0.05, y: -0.02, size: 0.95, opacity: 0.62 },
  // Saturated orchid-lilac, top-right — the strongest note in the mockup.
  { color: '#D9A2E8', x: 0.52, y: -0.06, size: 1.05, opacity: 0.7 },
  // Pink blush bridging the two upper blooms.
  { color: '#F2A7C3', x: 0.2, y: 0.06, size: 0.8, opacity: 0.4 },
  // Cool periwinkle wash through the middle band.
  { color: '#B9B3F2', x: 0.3, y: 0.3, size: 1.15, opacity: 0.34 },
  // Pale violet lifting the lower half.
  { color: '#CFC6F0', x: -0.15, y: 0.55, size: 1.0, opacity: 0.4 },
  // Faint warm echo bottom-right so the base doesn't read flat.
  { color: '#EAD3E4', x: 0.55, y: 0.72, size: 0.9, opacity: 0.34 },
] as const;

// ── Bottom navigation bar ─────────────────────────────────────────────────
// Solid white bar; the active tab is filled with the purple accent.
export const NAV_BAR = {
  background: '#FFFFFF',
  activeFill: '#8875F6',
  activeIcon: '#FFFFFF',
  inactiveIcon: '#9A96A8',
};

// Purple accent gradient for primary buttons / the "+" pill.
export const ACCENT_GRADIENT = {
  colors: ['#9C8AFA', '#8170F2'] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 1 },
};

// Priority pill palette (Add New Task + task cards).
export type Priority = 'Low' | 'Medium' | 'High';
export const PRIORITY_COLORS: Record<Priority, { color: string; bg: string }> = {
  Low: { color: '#4CAF7D', bg: '#E9F6EE' },
  Medium: { color: '#E9A23B', bg: '#FCF2E3' },
  High: { color: '#E5484D', bg: '#FCE9EA' },
};

// Extra bottom room on scroll content so it clears the floating tab bar.
export const TAB_BAR_CLEARANCE = 110;
