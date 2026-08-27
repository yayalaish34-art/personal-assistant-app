import { ReactNode, useEffect, useRef } from 'react';
import { Animated, Easing, StyleProp, ViewStyle } from 'react-native';

// The app's shared movement vocabulary.
//
// Three moves, used everywhere so the screens feel like one thing: a spring
// entrance (things build in reading order, staggered by `delay`), a slow float
// (things that should feel alive at rest), and a breath (a pulse for the one
// control asking to be pressed). All of it rides the native driver.

/** Springs its children up into place once, `delay` ms after mount. */
export function Entrance({
  delay = 0,
  from = 24,
  style,
  children,
}: {
  delay?: number;
  /** How far below its resting place the element starts, in px. */
  from?: number;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(v, {
      toValue: 1,
      delay,
      friction: 8,
      tension: 46,
      useNativeDriver: true,
    }).start();
  }, [delay, v]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v,
          transform: [
            { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [from, 0] }) },
            { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
          ],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

/**
 * A slow endless bob. Returns a translateY to drop into a transform; give each
 * floating thing its own `delay` so they don't rise and fall in lockstep.
 */
export function useFloat(
  amplitude = 6,
  duration = 2800,
  delay = 0,
): Animated.AnimatedInterpolation<number> {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.sequence([
      Animated.delay(delay),
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      ),
    ]);
    anim.start();
    return () => anim.stop();
  }, [amplitude, delay, duration, v]);
  return v.interpolate({ inputRange: [0, 1], outputRange: [0, -amplitude] });
}

/** A gentle scale pulse — for the one button on a screen that wants pressing. */
export function useBreathe(
  from = 1,
  to = 1.04,
  duration = 1400,
  delay = 0,
): Animated.AnimatedInterpolation<number> {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const anim = Animated.sequence([
      Animated.delay(delay),
      Animated.loop(
        Animated.sequence([
          Animated.timing(v, {
            toValue: 1,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(v, {
            toValue: 0,
            duration,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ]),
      ),
    ]);
    anim.start();
    return () => anim.stop();
  }, [delay, duration, v]);
  return v.interpolate({ inputRange: [0, 1], outputRange: [from, to] });
}
