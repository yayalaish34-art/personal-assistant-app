import { View, Text, StyleSheet } from 'react-native';
import {
  Battery,
  Sun,
  Users,
  ListChecks,
  Wallet,
  House,
  Car,
} from 'lucide-react-native';
import { Chip } from './ProfileFields';
import { type Profile } from '../lib/storage';
import { t, alignStart } from '../lib/i18n';
import { colors, NIGHT, AURA, font, spacing, radius, type AuraKey } from '../theme';

/**
 * The questionnaire's deeper layer: twelve questions a thoughtful friend
 * would ask before offering to help. Five of them are the original behavioural
 * knobs (work-days through assistance-style); the seven below them go into the
 * texture of a day — when energy drops, what a weekend is actually for, how
 * dense a day should feel, who else counts in it. Each ships three ways:
 *
 *   1. a Profile field with sensible defaults in `storage.ts`,
 *   2. an answer the agent reads as one line of her system prompt (see
 *      `profileLines` in backend/src/modules/voice/agent.ts), and
 *   3. a lit "insight tile" below the chips showing WHAT the choice changes —
 *      so an answer feels like it lands on something, not another feature in
 *      a feature list.
 */

export const PERSONALIZATION_QUESTIONS = [
  'workDays',
  'focusPeriod',
  'primaryGoal',
  'sleepQuality',
  'assistanceStyle',
  // The seven deeper questions, in the order they are asked.
  'energyLow',
  'moneyMood',
  'planningDensity',
  'weekendRhythm',
  'socialBattery',
  'commute',
  'household',
] as const;
export type PersonalizationQuestion = (typeof PERSONALIZATION_QUESTIONS)[number];

const CHOICES = {
  focusPeriod: ['morning', 'afternoon', 'evening', 'flexible'],
  primaryGoal: ['balance', 'productivity', 'lessStress', 'health', 'finances'],
  sleepQuality: ['rested', 'tired', 'irregular', 'unspecified'],
  assistanceStyle: ['brief', 'guided', 'proactive'],
  energyLow: ['lateMorning', 'afternoon', 'afterDinner', 'steady'],
  weekendRhythm: ['rest', 'catchUp', 'family', 'adventure', 'mixed'],
  socialBattery: ['fills', 'drains', 'depends', 'balanced'],
  planningDensity: ['theHour', 'looseAnchors', 'shortList', 'justNext'],
  moneyMood: ['safeToSpend', 'whatIsComing', 'fullPicture', 'noSurprises'],
  commute: ['car', 'transit', 'walk', 'mix'],
  household: ['partner', 'kids', 'parents', 'roommates', 'justMe'],
} as const;

/**
 * Which of the eight deeper questions show their insight tile, and in which
 * hue — chosen so the row of chapters doesn't settle on one colour. The five
 * original questions above intentionally keep their lighter treatment.
 */
const INSIGHT_SKIN: Partial<Record<PersonalizationQuestion, { tile: AuraKey; Icon: typeof Battery }>> = {
  energyLow: { tile: 'yellow', Icon: Battery },
  weekendRhythm: { tile: 'yellow', Icon: Sun },
  socialBattery: { tile: 'blue', Icon: Users },
  planningDensity: { tile: 'yellow', Icon: ListChecks },
  moneyMood: { tile: 'green', Icon: Wallet },
  household: { tile: 'yellow', Icon: House },
  commute: { tile: 'blue', Icon: Car },
};

/** Whether this question's answer is set to something other than its default. */
function hasAnswer(question: PersonalizationQuestion, profile: Profile): boolean {
  if (question === 'workDays') return profile.workDays.length > 0;
  if (question === 'household') return profile.household.length > 0;
  const v = profile[question] as unknown as string | undefined;
  return Boolean(v) && v !== 'unspecified';
}

/** The i18n key for the insight line that renders once an answer has been picked. */
function tipKey(question: PersonalizationQuestion, profile: Profile): string | null {
  if (!hasAnswer(question, profile)) return null;
  if (question === 'household') {
    // Pick one tip based on the richest axis of their household — kids first,
    // then partner, then everyone-else, so the line stays specific.
    const h = profile.household;
    if (h.includes('kids')) return 'onboarding.household.tip.kids';
    if (h.includes('partner')) return 'onboarding.household.tip.partner';
    if (h.includes('parents') || h.includes('roommates')) return 'onboarding.household.tip.others';
    return 'onboarding.household.tip.justMe';
  }
  const value = profile[question] as unknown as string;
  return `onboarding.${question}.tip.${value}`;
}

/**
 * A glass card that spells out what the chosen answer actually changes. Reads
 * as a thought from a friend ("I'll do X with this"), not a confirmation.
 */
function InsightTile({ question, profile }: { question: PersonalizationQuestion; profile: Profile }) {
  const skin = INSIGHT_SKIN[question];
  const key = tipKey(question, profile);
  if (!skin || !key) return null;
  const { tile, Icon } = skin;
  return (
    <View style={styles.insight}>
      <View style={[styles.insightBadge, { backgroundColor: AURA[tile].tint }]}>
        <Icon color={AURA[tile].ink} size={16} strokeWidth={2.3} />
      </View>
      <Text style={[styles.insightText, { textAlign: alignStart() }]}>{t(key)}</Text>
    </View>
  );
}

export function PersonalizationField({
  question,
  profile,
  onChange,
}: {
  question: PersonalizationQuestion;
  profile: Profile;
  onChange: (patch: Partial<Profile>) => void;
}) {
  // Work-days keep their own tiny grid of weekday chips.
  if (question === 'workDays') {
    return (
      <View style={{ gap: 12 }}>
        <View style={styles.chipWrap}>
          {Array.from({ length: 7 }, (_, day) => (
            <Chip
              key={day}
              label={t(`onboarding.workDays.${day}`)}
              active={profile.workDays.includes(day)}
              surface={NIGHT.card}
              onPress={() =>
                onChange({
                  workDays: profile.workDays.includes(day)
                    ? profile.workDays.filter((d) => d !== day)
                    : [...profile.workDays, day].sort(),
                })
              }
            />
          ))}
        </View>
      </View>
    );
  }

  // Household is multi-select. The others are single-choice.
  if (question === 'household') {
    const current = profile.household;
    return (
      <View style={{ gap: 12 }}>
        <View style={styles.chipWrap}>
          {CHOICES.household.map((choice) => {
            const active = current.includes(choice);
            return (
              <Chip
                key={choice}
                label={t(`onboarding.household.${choice}`)}
                active={active}
                surface={NIGHT.card}
                onPress={() => {
                  // "justMe" is exclusive — picking it clears the rest, and
                  // picking anything else clears "justMe". Saying both would
                  // be a lie to the agent.
                  if (choice === 'justMe') {
                    onChange({ household: active ? [] : ['justMe'] });
                    return;
                  }
                  const next = active
                    ? current.filter((h) => h !== choice)
                    : [...current.filter((h) => h !== 'justMe'), choice];
                  onChange({ household: next });
                }}
              />
            );
          })}
        </View>
        <InsightTile question="household" profile={profile} />
      </View>
    );
  }

  const options = CHOICES[question];
  return (
    <View style={{ gap: 12 }}>
      <View style={styles.chipWrap}>
        {options.map((choice) => (
          <Chip
            key={choice}
            label={t(`onboarding.${question}.${choice}`)}
            active={(profile[question] as unknown as string) === choice}
            surface={NIGHT.card}
            onPress={() => onChange({ [question]: choice } as unknown as Partial<Profile>)}
          />
        ))}
      </View>
      {question === 'sleepQuality' && profile.sleepQuality !== 'unspecified' ? (
        <Text style={[styles.legacyTip, { textAlign: alignStart() }]}>
          {t(`onboarding.sleepQuality.tip.${profile.sleepQuality}`)}
        </Text>
      ) : (
        <InsightTile question={question} profile={profile} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  legacyTip: {
    color: colors.textMuted,
    ...font(400),
    lineHeight: 22,
  },
  insight: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.sm + 2,
    borderRadius: radius.md,
    backgroundColor: NIGHT.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: NIGHT.line,
  },
  insightBadge: {
    width: 30,
    height: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  insightText: {
    flex: 1,
    color: colors.text,
    ...font(400),
    lineHeight: 21,
    fontSize: 14.5,
  },
});
