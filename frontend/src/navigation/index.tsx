import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  Pressable,
  Animated,
  StyleSheet,
  Platform,
  LayoutAnimation,
  UIManager,
  type LayoutRectangle,
} from 'react-native';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';

import { colors, font, NAV_BAR } from '../theme';
import { TabIcon } from '../components/TabIcons';
import TodayScreen from '../screens/TodayScreen';
import JournalScreen from '../screens/JournalScreen';
import CalendarScreen from '../screens/CalendarScreen';
import SettingsScreen from '../screens/SettingsScreen';
import EntryFormScreen from '../screens/EntryFormScreen';
import AssistantScreen from '../screens/AssistantScreen';

export type RootStackParamList = {
  Tabs: undefined;
  // 'task' → POST /tasks, 'event' → POST /events. Two separate resources.
  EntryForm: { kind: 'task' | 'event' };
  Assistant: undefined;
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

// Enable smooth layout transitions (pill expand) on Android.
if (
  Platform.OS === 'android' &&
  UIManager.setLayoutAnimationEnabledExperimental
) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const SPRING = { stiffness: 200, damping: 22, mass: 1 } as const;

// ── Floating white tab bar with a purple pill that slides + expands to the
//    active tab. The active icon and label sit on the purple fill in white. ──
function FloatingTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const [layouts, setLayouts] = useState<Record<number, LayoutRectangle>>({});
  const pillX = useRef(new Animated.Value(0)).current;
  const pillW = useRef(new Animated.Value(0)).current;
  const pillOpacity = useRef(new Animated.Value(0)).current;
  const iconScales = useRef(
    state.routes.map((_, i) => new Animated.Value(i === state.index ? 1.08 : 1)),
  ).current;
  const focused = state.index;

  useEffect(() => {
    const l = layouts[focused];
    if (!l) return;
    // Animate the sibling tabs' width change (label appearing) alongside the pill.
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    Animated.parallel([
      Animated.spring(pillX, { toValue: l.x, useNativeDriver: false, ...SPRING }),
      Animated.spring(pillW, { toValue: l.width, useNativeDriver: false, ...SPRING }),
      Animated.timing(pillOpacity, { toValue: 1, duration: 160, useNativeDriver: false }),
    ]).start();
  }, [focused, layouts, pillX, pillW, pillOpacity]);

  useEffect(() => {
    // Gently pop the active icon and settle the rest.
    Animated.parallel(
      iconScales.map((v, i) =>
        Animated.spring(v, {
          toValue: i === focused ? 1.08 : 1,
          useNativeDriver: true,
          ...SPRING,
        }),
      ),
    ).start();
  }, [focused, iconScales]);

  return (
    <View style={styles.tabWrapper} pointerEvents="box-none">
      <View style={styles.barContainer}>
        <Animated.View
          style={[
            styles.activePill,
            { width: pillW, opacity: pillOpacity, transform: [{ translateX: pillX }] },
          ]}
        />

        {state.routes.map((route, index) => {
          const { options } = descriptors[route.key];
          const label =
            typeof options.title === 'string' ? options.title : route.name;
          const isFocused = state.index === index;
          // The purple pill is hidden until the first onLayout measures it, so
          // tie the white icon to the pill actually being there — otherwise the
          // active icon renders white on the white bar and looks missing.
          const onPill = isFocused && layouts[index] !== undefined;

          const onPress = () => {
            Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            const event = navigation.emit({
              type: 'tabPress',
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name);
            }
          };

          return (
            <Pressable
              key={route.key}
              onPress={onPress}
              onLayout={(e) => {
                const layout = e.nativeEvent.layout;
                setLayouts((prev) => ({ ...prev, [index]: layout }));
              }}
              style={styles.tab}
            >
              {/* One icon, colour picked from focus state. An earlier version
                  cross-faded two stacked copies, but that drove opacity from a
                  natively-driven Animated.Value — both as a raw value and via
                  .interpolate() — and a native value read from a JS-evaluated
                  style doesn't update, so the icon could settle at opacity 0
                  and disappear. Colour is not animatable on an SVG fill prop
                  anyway, so there is nothing to gain from the extra layer. */}
              <Animated.View
                style={[styles.iconBox, { transform: [{ scale: iconScales[index] }] }]}
              >
                <TabIcon
                  name={route.name}
                  color={onPill ? NAV_BAR.activeIcon : NAV_BAR.inactiveIcon}
                  size={26}
                />
              </Animated.View>
              {isFocused ? (
                <Text
                  style={[styles.tabLabel, !onPill && { color: NAV_BAR.inactiveIcon }]}
                  numberOfLines={1}
                >
                  {label}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

function Tabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Today" component={TodayScreen} options={{ title: 'Home' }} />
      <Tab.Screen name="Calendar" component={CalendarScreen} options={{ title: 'Calendar' }} />
      <Tab.Screen name="Journal" component={JournalScreen} options={{ title: 'Journal' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: 'Profile' }} />
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
  tabWrapper: {
    position: 'absolute',
    bottom: 14,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  barContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 100,
    paddingHorizontal: 11,
    paddingVertical: 11,
    gap: 6,
    backgroundColor: NAV_BAR.background,
    shadowColor: '#3F2E64',
    shadowOpacity: 0.14,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  activePill: {
    position: 'absolute',
    height: 56,
    backgroundColor: NAV_BAR.activeFill,
    borderRadius: 100,
    // Must equal barContainer's paddingVertical, or the pill sits off-centre.
    top: 11,
    left: 0,
    shadowColor: NAV_BAR.activeFill,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  tab: {
    height: 56,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 100,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 18,
  },
  iconBox: { width: 26, height: 26, alignItems: 'center', justifyContent: 'center' },
  tabLabel: { fontSize: 16, ...font(600), color: NAV_BAR.activeIcon },
});
