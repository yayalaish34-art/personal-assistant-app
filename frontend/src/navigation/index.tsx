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
import { TabIcon } from '../components/TabIcons';
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

const ICON_ACTIVE = '#1C1C1E';
const ICON_INACTIVE = 'rgba(60, 60, 67, 0.55)';

const SPRING = { stiffness: 200, damping: 22, mass: 1 } as const;

// ── Floating frosted-glass tab bar with a white pill that slides + expands
//    to the active tab, mirroring the reference design. ──
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
              <Animated.View style={{ transform: [{ scale: iconScales[index] }] }}>
                <TabIcon
                  name={route.name}
                  color={isFocused ? ICON_ACTIVE : ICON_INACTIVE}
                  size={26}
                />
              </Animated.View>
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
      <Tab.Screen name="Today" component={TodayScreen} options={{ title: 'Home' }} />
      <Tab.Screen name="Journal" component={JournalScreen} options={{ title: 'Journal' }} />
      <Tab.Screen name="Calendar" component={CalendarScreen} options={{ title: 'Calendar' }} />
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
  blurContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 100,
    paddingHorizontal: 11,
    paddingVertical: 10,
    gap: 6,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.6)',
    backgroundColor: 'rgba(255,255,255,0.28)',
    shadowColor: '#3F2E64',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  activePill: {
    position: 'absolute',
    height: 54,
    backgroundColor: '#FFFFFF',
    borderRadius: 100,
    top: 10,
    left: 0,
    shadowColor: '#000',
    shadowOpacity: 0.09,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
  },
  tab: {
    height: 54,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: 100,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 18,
  },
  tabLabel: { fontSize: 16, fontWeight: '600', color: '#111' },
});
