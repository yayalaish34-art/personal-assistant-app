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

// The app-wide background gradient, matched to the mockups:
// lilac in the top-left, blending through soft pink-peach into cream.
export const GRADIENT_BACKGROUND = {
  colors: ['#E4D4F4', '#EEDCE8', '#F6E7D9', '#F9F1E8'] as const,
  locations: [0, 0.3, 0.65, 1] as const,
  start: { x: 0.15, y: 0 },
  end: { x: 0.85, y: 1 },
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
