import { View, Text, StyleSheet } from 'react-native';
import Svg, { Circle, G } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';

// Mockup-style ring: a thick white donut, a purple-gradient disc in the
// middle with the percentage in white, a subtle lavender progress arc on the
// white ring, and a lime knob at the progress end.
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
  const c = 2 * Math.PI * r;
  const knobAngle = ((-90 + p * 360) * Math.PI) / 180;
  const kx = half + r * Math.cos(knobAngle);
  const ky = half + r * Math.sin(knobAngle);

  return (
    <View style={[styles.wrap, { width: size, height: size }]}>
      {/* White donut base */}
      <View style={[styles.donut, { width: size, height: size, borderRadius: half }]} />

      {/* Purple gradient disc with the percentage */}
      <LinearGradient
        colors={['#BA9FF9', '#8B6CF3']}
        start={{ x: 0.2, y: 0.05 }}
        end={{ x: 0.8, y: 1 }}
        style={[
          styles.disc,
          { width: inner, height: inner, borderRadius: inner / 2 },
        ]}
      >
        <Text style={styles.value}>
          {Math.round(p * 100)}
          <Text style={styles.pct}>%</Text>
        </Text>
      </LinearGradient>

      {/* Progress arc + lime knob */}
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <G rotation={-90} origin={`${half}, ${half}`}>
          <Circle
            cx={half}
            cy={half}
            r={r}
            stroke="rgba(139, 108, 243, 0.28)"
            strokeWidth={ring * 0.62}
            strokeLinecap="round"
            strokeDasharray={`${c * p} ${c}`}
            fill="none"
          />
        </G>
        {p > 0 ? (
          <Circle cx={kx} cy={ky} r={6.5} fill="#C6E265" stroke="#FFFFFF" strokeWidth={2.5} />
        ) : null}
      </Svg>
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
    shadowOpacity: 0.14,
    shadowRadius: 16,
    elevation: 4,
  },
  disc: { alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: 22, color: '#FFFFFF', fontWeight: '600' },
  pct: { fontSize: 12, fontWeight: '500' },
});
