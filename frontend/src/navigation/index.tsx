import { useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  createBottomTabNavigator,
  type BottomTabBarProps,
} from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { House, Calendar, ChartNoAxesColumn, User, Plus } from 'lucide-react-native';

import { isRTL } from '../lib/i18n';
import { useTheme } from '../lib/theme';
import { navBar, radius, type Palette } from '../theme';
import TodayScreen from '../screens/TodayScreen';
import JournalScreen from '../screens/JournalScreen';
import CalendarScreen from '../screens/CalendarScreen';
import SettingsScreen from '../screens/SettingsScreen';
import EntryFormScreen from '../screens/EntryFormScreen';
import AssistantScreen from '../screens/AssistantScreen';

export type RootStackParamList = {
  Tabs: undefined;
  // 'task' → a task, 'event' → a calendar entry. Two separate resources.
  EntryForm: { kind: 'task' | 'event' };
  Assistant: undefined;
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator<RootStackParamList>();

/** Outline icons, matching the reference. Active is filled with the accent. */
const ICONS = {
  Today: House,
  Calendar: Calendar,
  Journal: ChartNoAxesColumn,
  Settings: User,
} as const;

const BAR_HEIGHT = 64;
const FAB_SIZE = 58;

/**
 * Flat bottom bar with a raised centre action.
 *
 * The reference has no floating card and no sliding pill: a flush bar, four
 * outline icons, and a large accent circle straddling the bar's top edge. The
 * circle sits in the middle of the row — two tabs, the button, two tabs — so
 * it occupies a layout slot rather than being absolutely positioned, which
 * keeps it centred on any width without measuring.
 */
function BottomBar({ state, navigation }: BottomTabBarProps) {
  const { palette: c } = useTheme();
  const insets = useSafeAreaInsets();
  const nav = useMemo(() => navBar(c), [c]);
  const styles = useMemo(() => makeStyles(c), [c]);

  const go = (index: number) => {
    const route = state.routes[index];
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
    navigation.navigate('Assistant' as never);
  };

  const tab = (index: number) => {
    const route = state.routes[index];
    if (!route) return null;
    const Icon = ICONS[route.name as keyof typeof ICONS] ?? House;
    const active = state.index === index;
    return (
      <Pressable
        key={route.key}
        onPress={() => go(index)}
        style={styles.tab}
        hitSlop={8}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
      >
        <Icon
          color={active ? nav.activeIcon : nav.inactiveIcon}
          size={25}
          strokeWidth={active ? 2.4 : 1.9}
        />
      </Pressable>
    );
  };

  // Mirror the tab order under RTL so the first tab stays on the leading edge.
  const order = isRTL() ? [3, 2, 1, 0] : [0, 1, 2, 3];
  const [a, b, d, e] = order;

  return (
    <View
      style={[
        styles.bar,
        { paddingBottom: insets.bottom, height: BAR_HEIGHT + insets.bottom },
      ]}
    >
      {tab(a)}
      {tab(b)}

      {/* Layout slot for the raised button: reserves the gap so the four icons
          stay evenly distributed around it. */}
      <View style={styles.fabSlot}>
        <Pressable
          onPress={openAssistant}
          style={({ pressed }) => [styles.fab, pressed && { opacity: 0.85 }]}
          accessibilityRole="button"
        >
          <Plus color={nav.fabIcon} size={28} strokeWidth={2.6} />
        </Pressable>
      </View>

      {tab(d)}
      {tab(e)}
    </View>
  );
}

function Tabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <BottomBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Today" component={TodayScreen} />
      <Tab.Screen name="Calendar" component={CalendarScreen} />
      <Tab.Screen name="Journal" component={JournalScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  const { palette: c } = useTheme();
  return (
    <Stack.Navigator
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: c.bg },
      }}
    >
      <Stack.Screen name="Tabs" component={Tabs} />
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

function makeStyles(c: Palette) {
  const nav = navBar(c);
  return StyleSheet.create({
    bar: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: nav.background,
      // A hairline above the bar separates it from content scrolling beneath.
      borderTopWidth: c.mode === 'dark' ? 0 : 1,
      borderTopColor: c.border,
    },
    tab: {
      flex: 1,
      height: BAR_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fabSlot: {
      width: FAB_SIZE + 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fab: {
      width: FAB_SIZE,
      height: FAB_SIZE,
      borderRadius: FAB_SIZE / 2,
      backgroundColor: nav.fabFill,
      alignItems: 'center',
      justifyContent: 'center',
      // Lifted so it straddles the bar's top edge, as in the reference.
      marginBottom: FAB_SIZE * 0.55,
      shadowColor: nav.fabFill,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.45,
      shadowRadius: 14,
      elevation: 10,
    },
    radiusRef: { borderRadius: radius.pill },
  });
}
