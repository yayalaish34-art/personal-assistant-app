import { View, Text } from 'react-native';
import { Chip } from './ProfileFields';
import { type Profile } from '../lib/storage';
import { t, alignStart } from '../lib/i18n';
import { colors, NIGHT, font } from '../theme';

export const PERSONALIZATION_QUESTIONS = [
  'workDays', 'focusPeriod', 'primaryGoal', 'sleepQuality', 'assistanceStyle',
] as const;
export type PersonalizationQuestion = typeof PERSONALIZATION_QUESTIONS[number];

const CHOICES = {
  focusPeriod: ['morning', 'afternoon', 'evening', 'flexible'],
  primaryGoal: ['balance', 'productivity', 'lessStress', 'health', 'finances'],
  sleepQuality: ['rested', 'tired', 'irregular', 'unspecified'],
  assistanceStyle: ['brief', 'guided', 'proactive'],
} as const;

export function PersonalizationField({ question, profile, onChange }: {
  question: PersonalizationQuestion;
  profile: Profile;
  onChange: (patch: Partial<Profile>) => void;
}) {
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {question === 'workDays'
          ? Array.from({ length: 7 }, (_, day) => (
            <Chip key={day} label={t(`onboarding.workDays.${day}`)}
              active={profile.workDays.includes(day)} surface={NIGHT.card}
              onPress={() => onChange({ workDays: profile.workDays.includes(day)
                ? profile.workDays.filter((d) => d !== day)
                : [...profile.workDays, day].sort() })} />
          ))
          : CHOICES[question].map((choice) => (
            <Chip key={choice} label={t(`onboarding.${question}.${choice}`)}
              active={profile[question] === choice} surface={NIGHT.card}
              onPress={() => onChange({ [question]: choice })} />
          ))}
      </View>
      {question === 'sleepQuality' && profile.sleepQuality !== 'unspecified' ? (
        <Text style={{ color: colors.textMuted, ...font(400), lineHeight: 22, textAlign: alignStart() }}>
          {t(`onboarding.sleepQuality.tip.${profile.sleepQuality}`)}
        </Text>
      ) : null}
    </View>
  );
}
