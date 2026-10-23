import {
  ReactNode,
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
  LayoutAnimation,
  Pressable as RNPressable,
  StyleSheet,
  Text,
  type GestureResponderEvent,
  type LayoutChangeEvent,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type TextStyle,
  type View,
  type ViewStyle,
} from 'react-native';
import { NavigationContext } from '@react-navigation/native';

// The app's shared movement vocabulary.
//
// Everything that moves goes through here, so the screens feel like one thing:
// a spring entrance that builds a page in reading order and builds it again
// every time the page comes back into view, a press that gives under the finger
// and springs back, numbers that count to their value, bars that grow to it,
// a pop for the thing that just became chosen, and a slow float and a breath
// for things that should feel alive at rest. Transforms and opacity ride the
// native driver; only widths and text run on the JS thread.
//
// All of it stands still for someone who has asked their phone for less
// motion. That is an accessibility setting, not a taste — for some people
// movement like this is what makes an app unusable.

// ── Reduced motion ──────────────────────────────────────────────────────────

let reduceMotion = false;
const motionListeners = new Set<() => void>();
const setReduceMotion = (on: boolean) => {
  reduceMotion = on;
  motionListeners.forEach((l) => l());
};
AccessibilityInfo.isReduceMotionEnabled()
  .then(setReduceMotion)
  .catch(() => undefined);
AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);

/** Whether the device has asked for less motion. Re-renders when that changes. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (listener) => {
      motionListeners.add(listener);
      return () => motionListeners.delete(listener);
    },
    () => reduceMotion,
    () => false,
  );
}

// ── Replaying a page ────────────────────────────────────────────────────────

/**
 * Bumps each time the page around it comes back into view.
 *
 * Tabs stay mounted, so an entrance that runs on mount runs once per launch:
 * the second visit to Calendar found everything already standing there. The
 * pieces below read this and play again when it changes.
 */
const ReplayContext = createContext(0);

/**
 * Plays a page in: the whole page lifts and fades up as it opens, and every
 * `Entrance`, `CountUp` and `useGrow` inside it plays again.
 *
 * "Comes back" means a focus after a blur — switching back to a tab, closing a
 * sheet that covered it. The first focus is the mount, which animates anyway.
 * Outside a navigator (the intro, the questionnaire) it plays on mount only.
 */
export function PageReveal({ children }: { children: ReactNode }) {
  const navigation = useContext(NavigationContext);
  const reduce = useReducedMotion();
  const [replay, setReplay] = useState(0);
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;

  useEffect(() => {
    if (!navigation) return;
    let away = false;
    const offBlur = navigation.addListener('blur', () => {
      away = true;
    });
    const offFocus = navigation.addListener('focus', () => {
      if (!away) return;
      away = false;
      setReplay((n) => n + 1);
    });
    return () => {
      offBlur();
      offFocus();
    };
  }, [navigation]);

  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    v.setValue(0);
    const anim = Animated.timing(v, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
  }, [replay, reduce, v]);

  return (
    <ReplayContext.Provider value={replay}>
      <Animated.View
        style={[
          styles.fill,
          {
            opacity: v,
            transform: [
              { translateY: v.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) },
              { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.985, 1] }) },
            ],
          },
        ]}
      >
        {children}
      </Animated.View>
    </ReplayContext.Provider>
  );
}

/**
 * True once when the page replays, for a value that should restart from zero
 * then — and only then. A delay or a target changing afterwards must not
 * blank what is already on screen.
 */
function useReplayed(): () => boolean {
  const replay = useContext(ReplayContext);
  const seen = useRef(replay);
  return () => {
    if (seen.current === replay) return false;
    seen.current = replay;
    return true;
  };
}

// ── Entrances ───────────────────────────────────────────────────────────────

/**
 * Springs its children up into place, `delay` ms after mount — and again every
 * time the page it is on comes back into view.
 */
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
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  const replayed = useReplayed();
  const replay = useContext(ReplayContext);
  // Read when the entrance starts, not watched: a screen that shortens its
  // delays once it has settled would otherwise restart the wait of anything
  // still on its way in, and it would stop halfway up the page to wait again.
  const delayRef = useRef(delay);
  delayRef.current = delay;

  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    if (replayed()) v.setValue(0);
    const anim = Animated.spring(v, {
      toValue: 1,
      delay: delayRef.current,
      friction: 8,
      tension: 46,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
    // `replayed` and the delay are read inside on purpose; mount and `replay`
    // are what start it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay, reduce, v]);

  return (
    <Animated.View
      style={[
        style,
        {
          opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0, 1], extrapolate: 'clamp' }),
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
 * Springs in when it mounts, from small to its size — for the thing that just
 * became chosen: a lit day, a filled tick, the fill behind a chip. Mount it
 * only while the thing is chosen and the choice itself is the animation.
 */
export function PopIn({
  children,
  style,
  from = 0.7,
  delay = 0,
}: {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** The scale it starts at. */
  from?: number;
  /** For a row of pops, staggered. Read when it starts, like `Entrance`'s. */
  delay?: number;
}) {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(reduce ? 1 : 0)).current;
  const replayed = useReplayed();
  const replay = useContext(ReplayContext);
  const delayRef = useRef(delay);
  delayRef.current = delay;

  useEffect(() => {
    if (reduce) {
      v.setValue(1);
      return;
    }
    // Pops again when the page comes back, with everything else on it.
    if (replayed()) v.setValue(0);
    const anim = Animated.spring(v, {
      toValue: 1,
      delay: delayRef.current,
      friction: 5,
      tension: 140,
      useNativeDriver: true,
    });
    anim.start();
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replay, reduce, v]);

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        style,
        {
          opacity: v.interpolate({ inputRange: [0, 0.6], outputRange: [0, 1], extrapolate: 'clamp' }),
          transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [from, 1] }) }],
        },
      ]}
    >
      {children}
    </Animated.View>
  );
}

// ── Presses ─────────────────────────────────────────────────────────────────

const AnimatedPressable = Animated.createAnimatedComponent(RNPressable);

/**
 * `Pressable`, but it gives under the finger and springs back when let go.
 *
 * A drop-in: every screen imports this one instead of React Native's, so
 * every button, row, chip and tab in the app answers a press the same way,
 * and a new control gets it for free. Style functions, `children` functions
 * and every other prop behave as they do on the original.
 *
 * How far it gives comes from its own size unless `pressScale` says otherwise:
 * a small round button dips a lot, a full-width row barely — the same dip on
 * both reads as the row lurching. Something the size of the page, like a
 * sheet's backdrop, does not move at all.
 *
 * The release is a spring with a little overshoot. That is what makes it feel
 * like a physical thing being let go of rather than a style being removed.
 */
export const Pressable = forwardRef<View, PressableProps & { pressScale?: number }>(
  function Pressable({ style, onPressIn, onPressOut, onLayout, pressScale, ...rest }, ref) {
    const reduce = useReducedMotion();
    const scale = useRef(new Animated.Value(1)).current;
    const size = useRef({ w: 0, h: 0 });
    const [pressed, setPressed] = useState(false);

    const give = () => {
      if (pressScale !== undefined) return pressScale;
      const { w, h } = size.current;
      if (w >= 320 && h >= 320) return 1;
      if (w >= 260) return 0.975;
      if (w >= 120) return 0.955;
      if (w >= 56) return 0.92;
      return 0.86;
    };

    const springTo = (toValue: number, release: boolean) =>
      Animated.spring(scale, {
        toValue,
        friction: release ? 3.6 : 7,
        tension: release ? 170 : 260,
        useNativeDriver: true,
      }).start();

    const resolved = typeof style === 'function' ? style({ pressed }) : style;
    const flat = StyleSheet.flatten(resolved) ?? {};
    const own = Array.isArray(flat.transform) ? flat.transform : [];

    return (
      <AnimatedPressable
        ref={ref as never}
        {...rest}
        onPressIn={(e: GestureResponderEvent) => {
          setPressed(true);
          if (!reduce) springTo(give(), false);
          onPressIn?.(e);
        }}
        onPressOut={(e: GestureResponderEvent) => {
          setPressed(false);
          if (!reduce) springTo(1, true);
          onPressOut?.(e);
        }}
        onLayout={(e: LayoutChangeEvent) => {
          size.current = { w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height };
          onLayout?.(e);
        }}
        // The control's own transform first — a mirror, a lift — and the
        // press on top of it, so pressing never undoes how it is placed.
        style={[flat, { transform: [...own, { scale }] }]}
      />
    );
  },
);

// ── Numbers and bars ────────────────────────────────────────────────────────

/**
 * A number that counts to its value: from zero when the page opens, and from
 * where it was when the value changes, so a tick on a list visibly moves the
 * count instead of swapping it. `format` turns the running number into text —
 * pass the screen's own money or percent formatting.
 */
export function CountUp({
  value,
  format = (n) => String(Math.round(n)),
  duration = 900,
  style,
  ...textProps
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  style?: StyleProp<TextStyle>;
} & Omit<TextProps, 'children' | 'style'>) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const at = useRef(reduce ? value : 0);
  const replayed = useReplayed();
  const replay = useContext(ReplayContext);

  useEffect(() => {
    if (reduce) {
      at.current = value;
      setShown(value);
      return;
    }
    const start = replayed() ? 0 : at.current;
    if (start === value) {
      setShown(value);
      return;
    }
    const t0 = Date.now();
    let frame = 0;
    const tick = () => {
      const p = Math.min(1, (Date.now() - t0) / duration);
      const n = start + (value - start) * (1 - Math.pow(1 - p, 3));
      at.current = n;
      setShown(p === 1 ? value : n);
      if (p < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, replay, reduce, duration]);

  return (
    <Text style={style} {...textProps}>
      {format(shown)}
    </Text>
  );
}

/**
 * A 0–1 fraction that grows to `target`: from nothing when the page opens, and
 * from where it was when the target moves. For a bar's fill —
 * `width: grow.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })`.
 * Width cannot ride the native driver; this runs a handful of frames per change.
 */
export function useGrow(target: number, delay = 180): Animated.Value {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(reduce ? target : 0)).current;
  const replayed = useReplayed();
  const replay = useContext(ReplayContext);

  useEffect(() => {
    if (reduce) {
      v.setValue(target);
      return;
    }
    if (replayed()) v.setValue(0);
    const anim = Animated.spring(v, {
      toValue: target,
      delay,
      friction: 9,
      tension: 38,
      useNativeDriver: false,
    });
    anim.start();
    return () => anim.stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, replay, reduce, delay, v]);

  return v;
}

/**
 * Lets the next layout change animate — rows closing over the gap a deleted
 * one left, a ticked one sliding to the end of its list, a new one opening a
 * space. Call it on the line before the state change that moves things.
 *
 * It moves things and nothing else. Fading views in and out is left to the
 * views themselves: the same tap that reorders a list usually mounts a
 * `PopIn` or an `Entrance` too, and a layout fade on that view fights its own
 * opacity animation — on Android the two flicker.
 *
 * Does nothing on the web, where React Native's layout animation is a stub,
 * and nothing for someone who has asked for less motion.
 */
export function animateLayout(): void {
  if (reduceMotion) return;
  LayoutAnimation.configureNext({
    duration: 340,
    update: { type: 'spring', springDamping: 0.78 },
  });
}

// ── At rest ─────────────────────────────────────────────────────────────────

/**
 * A slow endless bob. Returns a translateY to drop into a transform; give each
 * floating thing its own `delay` so they don't rise and fall in lockstep.
 */
export function useFloat(
  amplitude = 6,
  duration = 2800,
  delay = 0,
): Animated.AnimatedInterpolation<number> {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      v.setValue(0);
      return;
    }
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
  }, [amplitude, delay, duration, reduce, v]);
  return v.interpolate({ inputRange: [0, 1], outputRange: [0, -amplitude] });
}

/** A gentle scale pulse — for the one button on a screen that wants pressing. */
export function useBreathe(
  from = 1,
  to = 1.04,
  duration = 1400,
  delay = 0,
): Animated.AnimatedInterpolation<number> {
  const reduce = useReducedMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduce) {
      v.setValue(0);
      return;
    }
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
  }, [delay, duration, reduce, v]);
  return v.interpolate({ inputRange: [0, 1], outputRange: [from, to] });
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
