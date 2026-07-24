// Central design tokens so screens stay visually consistent.
// Light "glassmorphism" system: a soft gradient background, translucent white
// cards, and gradient accents. Token keys are unchanged from the old dark theme
// so every screen picks up the new look without touching its own code.
export const colors = {
  // Fallback flat background (a mid stop of the gradient) for anything that
  // renders before/behind the LinearGradient.
  bg: '#D5D6DE',
  // Translucent "frosted glass" surfaces.
  surface: 'rgba(255, 255, 255, 0.45)',
  surfaceAlt: 'rgba(255, 255, 255, 0.6)',
  // Accent (solid fallback of the button gradient).
  primary: '#D29DE0',
  primaryText: '#ffffff',
  // Dark ink on light glass.
  text: '#1C1C1E',
  textMuted: 'rgba(60, 60, 67, 0.6)',
  border: 'rgba(255, 255, 255, 0.6)',
  danger: '#E8607A',
  success: '#5FBF8F',
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

// The app-wide background gradient. Every screen wraps itself in this.
export const GRADIENT_BACKGROUND = {
  colors: ['#BFD3DA', '#C9D6DD', '#D5D6DE', '#DCCFDC', '#E6D4E3'] as const,
  locations: [0, 0.25, 0.5, 0.75, 1] as const,
  start: { x: 0, y: 0.5 },
  end: { x: 1, y: 0.5 },
};

// Purple → pink gradient used on primary buttons and accents.
export const ACCENT_GRADIENT = {
  colors: ['#D8B4FE', '#F0ABFC', '#F9A8D4'] as const,
  start: { x: 0, y: 0 },
  end: { x: 1, y: 0 },
};

// Extra bottom room on scroll content so it clears the floating tab bar.
export const TAB_BAR_CLEARANCE = 110;
