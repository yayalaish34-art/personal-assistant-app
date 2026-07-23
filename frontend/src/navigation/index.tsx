import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Text } from 'react-native';

import { colors } from '../theme';
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

const tabIcon = (icon: string) => ({ color }: { color: string }) =>
  <Text style={{ fontSize: 20, color }}>{icon}</Text>;

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text },
        headerShadowVisible: false,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textMuted,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tab.Screen
        name="Today"
        component={TodayScreen}
        options={{ title: 'היום', tabBarIcon: tabIcon('🏠') }}
      />
      <Tab.Screen
        name="Journal"
        component={JournalScreen}
        options={{ title: 'יומן', tabBarIcon: tabIcon('📓') }}
      />
      <Tab.Screen
        name="Calendar"
        component={CalendarScreen}
        options={{ title: 'לוח שנה', tabBarIcon: tabIcon('📅') }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ title: 'הגדרות', tabBarIcon: tabIcon('⚙️') }}
      />
    </Tab.Navigator>
  );
}

export default function RootNavigator() {
  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTitleStyle: { color: colors.text },
        headerTintColor: colors.text,
        headerShadowVisible: false,
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
