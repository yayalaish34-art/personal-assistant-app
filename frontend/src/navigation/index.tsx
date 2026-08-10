import { useMemo } from 'react';
import { View, Pressable, StyleSheet, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { House, Calendar, ClipboardList, User, Plus } from 'lucide-react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, {
  Path,
  Defs,
  Filter,
  FeGaussianBlur,
  LinearGradient as SvgGradient,
  Stop,
} from 'react-native-svg';

import { colors, NAV_BAR } from '../theme';
import { t } from '../lib/i18n';
import TodayScreen from '../screens/TodayScreen';
import JournalScreen from '../screens/JournalScreen';
import CalendarScreen from '../screens/CalendarScreen';
import SettingsScreen from '../screens/SettingsScreen';
import EntryFormScreen from '../screens/EntryFormScreen';
import AssistantScreen from '../screens/AssistantScreen';

export type RootStackParamList = {
  Tabs: undefined;
  // 'task' → a task, 'event' → a calendar entry. Two separate resources.
  // With an `id` the form edits that row instead of creating a new one.
  EntryForm: { kind: 'task' | 'event'; id?: string };
  Assistant: undefined;
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

const ICONS = {
  Today: House,
  Calendar: Calendar,
  Journal: ClipboardList,
  Settings: User,
} as const;

// ── Bar geometry ──────────────────────────────────────────────────────────
// Everything below is measured from the bar's own top edge, with y growing
// downwards, so it drops straight into the SVG path.
const SIDE_MARGIN = 16;
const BAR_HEIGHT = 64;
const BAR_RADIUS = 28;
const HAIRLINE = 1;
/** Clear air under the bar, on top of the home-indicator inset. */
const FLOAT_GAP = 10;

// Two shadows: a tight one right under the bar for contact, and a wide one
// further down for height. `DROP` is how far each is pushed down, `BLUR` its
// standard deviation — a Gaussian reaches roughly 3× that.
const NEAR = { drop: 4, blur: 4 };
const FAR = { drop: 16, blur: 13 };
/**
 * Vertical slack in the SVG canvas so the wide shadow isn't cropped. There is
 * no horizontal equivalent: the canvas runs to the screen edges and no further.
 * Sized past them it widens the root view, which on a mirrored layout pushes
 * every screen sideways out of view — and off-screen shadow is invisible
 * anyway, so the margin either side is all the room it can use.
 */
const CANVAS_TOP = 30;
const CANVAS_BOTTOM = FAR.drop + FAR.blur * 3;

const FAB_SIZE = 58;
const FAB_R = FAB_SIZE / 2;
/** How far the button's centre floats above the bar's top edge. */
const FAB_LIFT = 14;
/** Even gap between the button and the cut edge, all the way around. */
const HALO = 8;

const NOTCH_R = FAB_R + HALO;
const NOTCH_CY = -FAB_LIFT;
/** Rounds off the shoulders where the scoop rejoins the straight top edge. */
const FILLET = 12;

// The shoulder circle is tangent to both the top edge (centre at y = FILLET)
// and the scoop (centres NOTCH_R + FILLET apart), which is what keeps the two
// arcs meeting without a crease. Solve for its x, then for where they touch.
const SHOULDER_X = Math.sqrt((NOTCH_R + FILLET) ** 2 - (FILLET - NOTCH_CY) ** 2);
const TOUCH = NOTCH_R / (NOTCH_R + FILLET);
const JOIN_X = SHOULDER_X * TOUCH;
const JOIN_Y = NOTCH_CY + (FILLET - NOTCH_CY) * TOUCH;

/**
 * The bar's top contour, left corner to right corner: a straight edge that
 * scoops down around the button. Drawn on its own as the rim light, and reused
 * as the opening of the closed outline below.
 */
function topEdge(width: number, dy: number) {
  const i = HAIRLINE / 2; // keep the stroke inside the canvas
  const cx = width / 2;
  const r = BAR_RADIUS;

  return [
    `M ${i} ${i + r + dy}`,
    `A ${r} ${r} 0 0 1 ${i + r} ${i + dy}`,
    `H ${cx - SHOULDER_X}`,
    `A ${FILLET} ${FILLET} 0 0 1 ${cx - JOIN_X} ${i + JOIN_Y + dy}`,
    `A ${NOTCH_R} ${NOTCH_R} 0 0 0 ${cx + JOIN_X} ${i + JOIN_Y + dy}`,
    `A ${FILLET} ${FILLET} 0 0 1 ${cx + SHOULDER_X} ${i + dy}`,
    `H ${width - i - r}`,
    `A ${r} ${r} 0 0 1 ${width - i} ${i + r + dy}`,
  ];
}

/** The whole bar as one outline: rounded rect with a scoop bitten out on top. */
function barPath(width: number, dy = 0) {
  const i = HAIRLINE / 2;
  const r = BAR_RADIUS;
  const right = width - i;
  const bottom = BAR_HEIGHT - i + dy;

  return [
    ...topEdge(width, dy),
    `V ${bottom - r}`,
    `A ${r} ${r} 0 0 1 ${right - r} ${bottom}`,
    `H ${i + r}`,
    `A ${r} ${r} 0 0 1 ${i} ${bottom - r}`,
    'Z',
  ].join(' ');
}

/**
 * Bottom bar: four outline icons around a raised orange + in the middle.
 *
 * The + isn't a slot in the row — it floats above the bar, and the bar's top
 * edge scoops down to clear it. The scoop is centred on the bar, so it lands
 * under the button at any width without measuring anything.
 *
 * The panel is drawn in SVG rather than as a styled View because a View's
 * shadow follows its bounding box: it would smear straight across the scoop
 * and fill the gap around the button. Blurring copies of the real outline
 * keeps the shadow the same shape as the thing casting it.
 */
function BottomBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const order = useMemo(() => state.routes.map((_, i) => i), [state.routes]);

  const barWidth = Math.max(width - SIDE_MARGIN * 2, 1);
  const paths = useMemo(
    () => ({
      panel: barPath(barWidth),
      near: barPath(barWidth, NEAR.drop),
      far: barPath(barWidth, FAR.drop),
      rim: topEdge(barWidth, 0).join(' '),
    }),
    [barWidth],
  );

  const go = (index: number) => {
    const route = state.routes[index];
    if (!route) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const event = navigation.emit({
      type: 'tabPress',
      target: route.key,
      canPreventDefault: true,
    });
    if (state.index !== index && !event.defaultPrevented) {
      navigation.navigate(route.name);
    }
  };

  const openAssistant = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // The tab navigator's helpers aren't typed for the parent stack's routes;
    // the navigation itself bubbles up fine.
    (navigation as unknown as { navigate: (name: string) => void }).navigate('Assistant');
  };

  const tab = (index: number) => {
    const route = state.routes[index];
    if (!route) return null;
    const Icon = ICONS[route.name as keyof typeof ICONS] ?? House;
    const active = state.index === index;
    const { options } = descriptors[route.key];
    const label = typeof options.title === 'string' ? options.title : route.name;

    return (
      <Pressable
        key={route.key}
        onPress={() => go(index)}
        style={styles.tab}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        // No visible label any more, so the tab name only survives here.
        accessibilityLabel={label}
      >
        <Icon
          color={active ? NAV_BAR.activeIcon : NAV_BAR.inactiveIcon}
          fill={active ? NAV_BAR.activeWash : 'transparent'}
          size={24}
          strokeWidth={active ? 2.2 : 1.8}
        />
      </Pressable>
    );
  };

  return (
    // Absolute, so the bar leaves the layout flow entirely: the screen behind
    // it runs to the bottom of the device and the page colour shows around the
    // bar, instead of the bar reserving a band of its own down there.
    // `box-none` keeps the gap beside the bar from swallowing taps.
    <View
      style={[styles.wrapper, { paddingBottom: Math.max(insets.bottom, 12) + FLOAT_GAP }]}
      pointerEvents="box-none"
    >
      {/* The assistant, who takes any request out loud. It sits *before* the
          bar with a negative margin rather than inside it: an absolute child
          overflowing the bar would still draw on Android, but wouldn't take
          taps up there. This way the button is inside the wrapper's own box. */}
      <Pressable
        onPress={openAssistant}
        style={({ pressed }) => [styles.fab, pressed && styles.fabPressed]}
        accessibilityRole="button"
        accessibilityLabel={t('voice.title')}
      >
        <LinearGradient
          colors={NAV_BAR.accentGradient}
          start={{ x: 0.15, y: 0 }}
          end={{ x: 0.85, y: 1 }}
          style={styles.fabFill}
        >
          <Plus color={NAV_BAR.accentIcon} size={28} strokeWidth={2.5} />
        </LinearGradient>
      </Pressable>

      <View style={styles.bar}>
        {/* Oversized on purpose: the canvas has to hold the blur that spills
            past the panel, and it's shifted back by the same amount so the
            panel itself still starts at the bar's own top-left. */}
        <Svg
          pointerEvents="none"
          width={width}
          height={BAR_HEIGHT + CANVAS_TOP + CANVAS_BOTTOM}
          viewBox={`${-SIDE_MARGIN} ${-CANVAS_TOP} ${width} ${
            BAR_HEIGHT + CANVAS_TOP + CANVAS_BOTTOM
          }`}
          style={[styles.canvas, { insetInlineStart: -SIDE_MARGIN, top: -CANVAS_TOP }]}
        >
          <Defs>
            <Filter id="near" x="-20%" y="-100%" width="140%" height="300%">
              <FeGaussianBlur in="SourceGraphic" stdDeviation={NEAR.blur} />
            </Filter>
            <Filter id="far" x="-20%" y="-150%" width="140%" height="400%">
              <FeGaussianBlur in="SourceGraphic" stdDeviation={FAR.blur} />
            </Filter>
            <SvgGradient id="glass" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={NAV_BAR.glassTop} />
              <Stop offset="1" stopColor={NAV_BAR.glassBottom} />
            </SvgGradient>
            {/* The rim light fades out towards the corners so it reads as a
                highlight rather than a drawn border. */}
            <SvgGradient id="rim" x1="0" y1="0" x2="1" y2="0">
              <Stop offset="0" stopColor={NAV_BAR.rim} stopOpacity="0" />
              <Stop offset="0.28" stopColor={NAV_BAR.rim} stopOpacity="0.9" />
              <Stop offset="0.5" stopColor={NAV_BAR.rim} stopOpacity="1" />
              <Stop offset="0.72" stopColor={NAV_BAR.rim} stopOpacity="0.9" />
              <Stop offset="1" stopColor={NAV_BAR.rim} stopOpacity="0" />
            </SvgGradient>
          </Defs>

          <Path d={paths.far} fill={NAV_BAR.shadowFar} filter="url(#far)" />
          <Path d={paths.near} fill={NAV_BAR.shadowNear} filter="url(#near)" />
          <Path
            d={paths.panel}
            fill="url(#glass)"
            stroke={NAV_BAR.edge}
            strokeWidth={HAIRLINE}
          />
          <Path d={paths.rim} fill="none" stroke="url(#rim)" strokeWidth={1.2} />
        </Svg>

        {tab(order[0] ?? 0)}
        {tab(order[1] ?? 1)}
        {/* Holds the row open under the scoop. */}
        <View style={styles.notchGap} />
        {tab(order[2] ?? 2)}
        {tab(order[3] ?? 3)}
      </View>
    </View>
  );
}

function Tabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <BottomBar {...props} />}
      screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: colors.bg } }}
    >
      <Tab.Screen name="Today" component={TodayScreen} options={{ title: t('tab.home') }} />
      <Tab.Screen
        name="Calendar"
        component={CalendarScreen}
        options={{ title: t('tab.calendar') }}
      />
      <Tab.Screen name="Journal" component={JournalScreen} options={{ title: t('tab.tasks') }} />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: t('tab.profile') }}
      />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="Tabs" component={Tabs} />
      {/* The Add New Task screen renders its own X / ✓ header. */}
      <Stack.Screen
        name="EntryForm"
        component={EntryFormScreen}
        options={{ presentation: 'modal' }}
      />
      <Stack.Screen
        name="Assistant"
        component={AssistantScreen}
        options={{ presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    insetInlineStart: 0,
    insetInlineEnd: 0,
    bottom: 0,
    paddingHorizontal: SIDE_MARGIN,
  },
  bar: {
    height: BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  canvas: { position: 'absolute' },
  tab: {
    flex: 1,
    height: BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notchGap: { width: SHOULDER_X * 2 },
  fab: {
    alignSelf: 'center',
    // Pulls the bar back up under the button until only FAB_LIFT of the
    // button's radius is left showing above the bar's top edge.
    marginBottom: -(FAB_R + FAB_LIFT),
    zIndex: 2,
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_R,
    backgroundColor: NAV_BAR.accent,
    // Its own glow, in its own colour — the button floats above the panel the
    // way the panel floats above the page. Kept tight: a wide one spills into
    // the gap around the scoop and muddies the edge the scoop is there to make.
    shadowColor: NAV_BAR.accent,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 11,
    elevation: 10,
  },
  fabPressed: { transform: [{ scale: 0.94 }], shadowOpacity: 0.2 },
  fabFill: {
    width: '100%',
    height: '100%',
    borderRadius: FAB_R,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
