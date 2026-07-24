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
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';

import { colors, radius } from '../theme';
import TodayScreen from '../screens/TodayScreen';
import JournalScreen from '../screens/JournalScreen';
import CalendarScreen from '../screens/CalendarScreen';
import SettingsScreen from '../screens/SettingsScreen';
import EntryFormScreen from '../screens/EntryFormScreen';

export type RootStackParamList = {
  Tabs: undefined;
  EntryForm: { kind: 'journal' | 'event' };
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

const TAB_ICON: Record<string, string> = {
  Today: '🏠',
  Journal: '📓',
  Calendar: '📅',
  Settings: '⚙️',
};

const SPRING = { stiffness: 200, damping: 22, mass: 1 } as const;

// ── Floating frosted-glass tab bar with a white pill that slides + expands
//    to the active tab, mirroring the reference design. ──
function FloatingTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const [layouts, setLayouts] = useState<Record<number, LayoutRectangle>>({});
  const pillX = useRef(new Animated.Value(0)).current;
  const pillW = useRef(new Animated.Value(0)).current;
  const pillOpacity = useRef(new Animated.Value(0)).current;
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

  return (
    <View style={styles.tabWrapper} pointerEvents="box-none">
      <BlurView intensity={60} tint="light" style={styles.blurContainer}>
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
              <Text style={[styles.tabIcon, { opacity: isFocused ? 1 : 0.55 }]}>
                {TAB_ICON[route.name] ?? '•'}
              </Text>
              {isFocused ? (
                <Text style={styles.tabLabel} numberOfLines={1}>
                  {label}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </BlurView>
    </View>
  );
}

function Tabs() {
  return (
    <Tab.Navigator
      tabBar={(props) => <FloatingTabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tab.Screen name="Today" component={TodayScreen} options={{ title: 'היום' }} />
      <Tab.Screen name="Journal" component={JournalScreen} options={{ title: 'יומן' }} />
      <Tab.Screen name="Calendar" component={CalendarScreen} options={{ title: 'לוח שנה' }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: 'הגדרות' }} />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: '#DCCFDC' },
        headerTitleStyle: { color: colors.text, fontWeight: '700' },
        headerTintColor: colors.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
      <Stack.Screen
        name="EntryForm"
        component={EntryFormScreen}
        options={{ title: 'רשומה חדשה', presentation: 'modal' }}
      />
    </Stack.Navigator>
  );
}

const styles = StyleSheet.create({
  tabWrapper: {
    position: 'absolute',
    bottom: 25,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  blurContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 100,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  activePill: {
    position: 'absolute',
    height: 48,
    backgroundColor: '#FFFFFF',
    borderRadius: 100,
    top: 8,
    left: 0,
    shadowColor: '#000',
    shadowOpacity: 0.09,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  tab: {
    height: 48,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 100,
    flexDirection: 'row',
    gap: 6,
    paddingHorizontal: 16,
  },
  tabIcon: { fontSize: 20 },
  tabLabel: { fontSize: 15, fontWeight: '600', color: '#111' },
});
