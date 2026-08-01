import { useMemo } from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createBottomTabNavigator, type BottomTabBarProps } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Haptics from 'expo-haptics';
import { House, Calendar, ClipboardList, User, Plus } from 'lucide-react-native';

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
  EntryForm: { kind: 'task' | 'event' };
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

const TAB_SIZE = 48;

/**
 * Flat bottom bar: four outline icons around a black + in the middle.
 *
 * The active tab is a filled black circle rather than a sliding pill, and the
 * + sits in its own slot between the second and third tab — so it stays
 * centred at any width without measuring anything.
 */
function BottomBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const order = useMemo(() => state.routes.map((_, i) => i), [state.routes]);

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
        style={[styles.tab, active && styles.tabActive]}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        // No visible label any more, so the tab name only survives here.
        accessibilityLabel={label}
      >
        <Icon
          color={active ? NAV_BAR.activeIcon : NAV_BAR.inactiveIcon}
          size={22}
          strokeWidth={active ? 2.2 : 1.8}
        />
      </Pressable>
    );
  };

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, 10) }]}>
      {tab(order[0] ?? 0)}
      {tab(order[1] ?? 1)}

      {/* The assistant, who takes any request out loud. A bare glyph, as in the
          reference — the filled circle belongs to the selected tab. */}
      <Pressable
        onPress={openAssistant}
        style={styles.addButton}
        accessibilityRole="button"
        accessibilityLabel={t('voice.title')}
      >
        <Plus color={colors.text} size={26} strokeWidth={2.2} />
      </Pressable>

      {tab(order[2] ?? 2)}
      {tab(order[3] ?? 3)}
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
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: NAV_BAR.background,
    paddingTop: 12,
    paddingHorizontal: 18,
  },
  tab: {
    width: TAB_SIZE,
    height: TAB_SIZE,
    borderRadius: TAB_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabActive: { backgroundColor: NAV_BAR.activeFill },
  addButton: {
    width: TAB_SIZE,
    height: TAB_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
