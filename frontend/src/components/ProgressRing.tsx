import { View, Text, StyleSheet } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient as SvgLinearGradient,
  Path,
  RadialGradient,
  Stop,
} from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';

import { font } from '../theme';

// Ring colors, sampled along the sweep: light violet at the start (top),
// deepening through mid purple to a saturated indigo at the end. The arc is
// painted as many small segments so the gradient follows the curve — SVG has
// no conic gradient, and a single linear one would run flat across the circle.
const ARC_STOPS = ['#C9B4FB', '#A98CF8', '#8E6BF2', '#7A55EC', '#6D46E3'] as const;

/** Lerp between two #rrggbb colors. */
function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** Color at position `t` (0..1) along ARC_STOPS. */
function arcColor(t: number): string {
  const p = Math.min(0.9999, Math.max(0, t)) * (ARC_STOPS.length - 1);
  const i = Math.floor(p);
  return mix(ARC_STOPS[i], ARC_STOPS[i + 1], p - i);
}

/** Point on the ring at angle fraction `t`, measured clockwise from 12 o'clock. */
function pointAt(t: number, cx: number, cy: number, r: number) {
  const a = (-90 + t * 360) * (Math.PI / 180);
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

// Mockup-style ring: a thick white donut, a purple-gradient disc in the middle
// with the percentage in white, a gradient progress arc on the white ring, and
// a lime knob at the progress end.
export function ProgressRing({
  progress,
  size = 128,
}: {
  progress: number; // 0..1
  size?: number;
}) {
  const p = Math.min(1, Math.max(0, progress));
  const half = size / 2;
  const ring = size * 0.155; // white ring thickness
  const inner = size - ring * 2; // purple disc diameter
  const r = half - ring / 2; // arc radius (center of the white ring)
  const stroke = ring * 0.72;
  const knob = pointAt(p, half, half, r);

  // One path per segment, each a flat color from the ramp. Enough segments that
  // the banding isn't visible; each overlaps its neighbour slightly (round caps
  // + a small angular overlap) so no seams show through.
  const SEGMENTS = 48;
  const count = Math.max(1, Math.ceil(SEGMENTS * p));
  const segments = Array.from({ length: count }, (_, i) => {
    const t0 = (i / SEGMENTS) * 1;
    const t1 = Math.min(p, (i + 1.35) / SEGMENTS); // 0.35 overlap hides seams
    if (t1 <= t0) return null;
    const a = pointAt(t0, half, half, r);
    const b = pointAt(t1, half, half, r);
    const large = t1 - t0 > 0.5 ? 1 : 0;
    return {
      d: `M ${a.x} ${a.y} A ${r} ${r} 0 ${large} 1 ${b.x} ${b.y}`,
      color: arcColor(p > 0 ? t0 / p : 0),
    };
  }).filter((s): s is { d: string; color: string } => s !== null);

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      {/* White donut base */}
      <View style={[styles.donut, { width: size, height: size, borderRadius: half }]} />

      {/* Track + gradient progress arc */}
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Defs>
          {/* Faint tint on the unfilled part of the track. */}
          <SvgLinearGradient id="track" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#F1EBFC" />
            <Stop offset="100%" stopColor="#E6DBF9" />
          </SvgLinearGradient>
        </Defs>

        <Circle cx={half} cy={half} r={r} stroke="url(#track)" strokeWidth={stroke} fill="none" />

        {segments.map((s, i) => (
          <Path
            key={i}
            d={s.d}
            stroke={s.color}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
          />
        ))}
      </Svg>

      {/* Purple gradient disc with the percentage */}
      <LinearGradient
        colors={['#C3ABFB', '#9C7BF5', '#7C57EE']}
        locations={[0, 0.5, 1]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={[styles.disc, { width: inner, height: inner, borderRadius: inner / 2 }]}
      >
        {/* Glossy highlight so the disc reads as a sphere, not a flat circle. */}
        <Svg
          width={inner}
          height={inner}
          style={[StyleSheet.absoluteFill, { borderRadius: inner / 2 }]}
          pointerEvents="none"
        >
          <Defs>
            <RadialGradient id="gloss" cx="32%" cy="22%" r="62%">
              <Stop offset="0%" stopColor="#FFFFFF" stopOpacity={0.5} />
              <Stop offset="60%" stopColor="#FFFFFF" stopOpacity={0.09} />
              <Stop offset="100%" stopColor="#FFFFFF" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={inner / 2} cy={inner / 2} r={inner / 2} fill="url(#gloss)" />
        </Svg>
        <Text style={styles.value}>
          {Math.round(p * 100)}
          <Text style={styles.pct}>%</Text>
        </Text>
      </LinearGradient>

      {/* Lime knob at the progress end, drawn last so it sits above the arc. */}
      {p > 0 ? (
        <Svg width={size} height={size} style={StyleSheet.absoluteFill} pointerEvents="none">
          <G>
            <Circle cx={knob.x} cy={knob.y} r={7} fill="#FFFFFF" opacity={0.55} />
            <Circle
              cx={knob.x}
              cy={knob.y}
              r={6.5}
              fill="#C6E265"
              stroke="#FFFFFF"
              strokeWidth={2.5}
            />
          </G>
        </Svg>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  donut: {
    position: 'absolute',
    backgroundColor: '#FFFFFF',
    shadowColor: '#5B3FA8',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 18,
    elevation: 4,
  },
  disc: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    shadowColor: '#4A2E9E',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },
  value: { fontSize: 24, color: '#FFFFFF', ...font(600), letterSpacing: -0.5 },
  pct: { fontSize: 13, ...font(500) },
});
