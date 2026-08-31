import { ScrollView, View, Text, Pressable, StyleSheet } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Mars, Venus, BedDouble } from 'lucide-react-native';

import { EVENT_TYPES, type EventType, type Gender } from '../lib/storage';
import { COUNTRIES, CURRENCIES, currencyOf, currencySymbol } from '../lib/currency';
import { colors, spacing, font, radius, type AuraKey, AURA } from '../theme';
import { t, isRTL, alignStart, locale } from '../lib/i18n';

/**
 * The controls the profile is built from.
 *
 * They live here rather than inside a screen because two screens now ask the
 * same questions: the opening questionnaire, one per step, and Settings, all
 * of them stacked in a card. Written twice they would drift — a buffer offered
 * in one place and not the other reads as a bug in whichever screen the user
 * saw second.
 *
 * Each takes the surface it sits on, because the two backgrounds differ:
 * onboarding paints straight onto the page, where a white chip reads as
 * raised, while Settings puts them inside a white card, where the same chip
 * would be invisible.
 */

/** Offered gaps between meetings, in minutes. */
export const BUFFERS = [0, 10, 15, 30];

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function hourLabel(hour: number): string {
  return t('onboarding.hour', { hour: String(hour).padStart(2, '0') });
}

function tap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** One pill. Selected ones invert to near-black. */
function Chip({
  label,
  active,
  onPress,
  surface,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  surface: string;
}) {
  return (
    <Pressable
      onPress={() => {
        tap();
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={[styles.chip, { backgroundColor: active ? colors.primary : surface }]}
    >
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A horizontal rail of hours, 00 through 23.
 *
 * The rail is a row of its own and a horizontal ScrollView does not inherit
 * the mirrored direction, so in Hebrew and Arabic it is flipped by hand — and
 * each chip flipped back, or the digits inside would read in reverse.
 */
export function HourPicker({
  value,
  onChange,
  tile,
  surface = colors.surface,
}: {
  value: number;
  onChange: (hour: number) => void;
  tile: AuraKey;
  surface?: string;
}) {
  const mirror = isRTL() ? [{ scaleX: -1 as number }] : undefined;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={{ transform: mirror }}
      contentContainerStyle={styles.hourRail}
    >
      {HOURS.map((hour) => {
        const active = hour === value;
        return (
          <Pressable
            key={hour}
            onPress={() => {
              tap();
              onChange(hour);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[
              styles.hourChip,
              { backgroundColor: active ? AURA[tile].tint : surface, transform: mirror },
            ]}
          >
            <Text style={[styles.hourText, active && styles.hourTextActive]}>
              {hourLabel(hour)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

/** A labelled from-hour and to-hour pair — work hours, or sleeping hours. */
export function HourRangePicker({
  from,
  to,
  onFrom,
  onTo,
  tile,
  surface = colors.surface,
}: {
  from: number;
  to: number;
  onFrom: (hour: number) => void;
  onTo: (hour: number) => void;
  tile: AuraKey;
  surface?: string;
}) {
  const start = { textAlign: alignStart() } as const;
  return (
    <>
      <Text style={[styles.railLabel, start]}>{hourLabel(from)}</Text>
      <HourPicker value={from} onChange={onFrom} tile={tile} surface={surface} />
      <Text style={[styles.railLabel, start]}>{hourLabel(to)}</Text>
      <HourPicker value={to} onChange={onTo} tile={tile} surface={surface} />
    </>
  );
}

/** How much room to leave between one thing and the next. */
export function BufferPicker({
  value,
  onChange,
  surface = colors.surface,
}: {
  value: number;
  onChange: (minutes: number) => void;
  surface?: string;
}) {
  return (
    <View style={styles.chipWrap}>
      {BUFFERS.map((minutes) => (
        <Chip
          key={minutes}
          label={
            minutes === 0
              ? t('onboarding.buffer.none')
              : t('onboarding.buffer.minutes', { count: minutes })
          }
          active={minutes === value}
          onPress={() => onChange(minutes)}
          surface={surface}
        />
      ))}
    </View>
  );
}

/** What kinds of thing fill someone's days. Multi-select; none is allowed. */
export function EventTypePicker({
  value,
  onChange,
  surface = colors.surface,
}: {
  value: EventType[];
  onChange: (types: EventType[]) => void;
  surface?: string;
}) {
  return (
    <View style={styles.chipWrap}>
      {EVENT_TYPES.map((type) => {
        const active = value.includes(type);
        return (
          <Chip
            key={type}
            label={t(`onboarding.type.${type}`)}
            active={active}
            onPress={() =>
              onChange(active ? value.filter((e) => e !== type) : [...value, type])
            }
            surface={surface}
          />
        );
      })}
    </View>
  );
}

const GENDER_OPTIONS = [
  { key: 'male', Icon: Mars, tile: 'blue' },
  { key: 'female', Icon: Venus, tile: 'yellow' },
] as const satisfies readonly { key: Exclude<Gender, 'unspecified'>; Icon: typeof Mars; tile: AuraKey }[];

/**
 * Man / woman / rather not say — asked once, only so the sleep card below can
 * put a number on "how much is recommended for you" instead of a number for
 * nobody in particular. Never required: the third option is a full answer.
 */
export function GenderPicker({
  value,
  onChange,
  surface = colors.surface,
}: {
  value: Gender;
  onChange: (gender: Gender) => void;
  surface?: string;
}) {
  return (
    <View>
      <View style={styles.genderRow}>
        {GENDER_OPTIONS.map(({ key, Icon, tile }) => {
          const active = value === key;
          return (
            <Pressable
              key={key}
              onPress={() => {
                tap();
                onChange(key);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[
                styles.genderCard,
                { backgroundColor: active ? AURA[tile].tint : surface },
              ]}
            >
              <Icon color={active ? AURA[tile].ink : colors.textMuted} size={26} strokeWidth={2} />
              <Text style={[styles.genderLabel, active && styles.genderLabelActive]}>
                {t(`onboarding.sleep.gender.${key}`)}
              </Text>
            </Pressable>
          );
        })}
      </View>
      <Pressable
        onPress={() => {
          tap();
          onChange('unspecified');
        }}
        accessibilityRole="button"
        accessibilityState={{ selected: value === 'unspecified' }}
        hitSlop={6}
      >
        <Text
          style={[
            styles.genderSkipText,
            value === 'unspecified' && styles.genderSkipTextActive,
          ]}
        >
          {t('onboarding.sleep.gender.skip')}
        </Text>
      </Pressable>
    </View>
  );
}

/** Hours asleep, crossing midnight when the end hour is before the start. */
export function sleepDuration(startHour: number, endHour: number): number {
  return ((endHour - startHour + 24) % 24) || 24;
}

const SLEEP_TARGET = { min: 7, max: 9 };

/**
 * The recommendation, plus a live read of what the picker above is actually
 * set to — the interactive half of the pair, so the number means something
 * the moment either hour changes instead of sitting there as a static tip.
 */
export function SleepInsight({
  gender,
  startHour,
  endHour,
  surface = colors.surface,
}: {
  gender: Gender;
  startHour: number;
  endHour: number;
  surface?: string;
}) {
  const hours = sleepDuration(startHour, endHour);
  const fit = hours < SLEEP_TARGET.min ? 'short' : hours > SLEEP_TARGET.max ? 'long' : 'good';
  const tile: AuraKey = fit === 'good' ? 'green' : fit === 'short' ? 'yellow' : 'blue';
  const start = { textAlign: alignStart() } as const;

  return (
    <View style={[styles.insightCard, { backgroundColor: surface }]}>
      <View style={[styles.insightIcon, { backgroundColor: AURA[tile].tint }]}>
        <BedDouble color={AURA[tile].ink} size={20} strokeWidth={2} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.insightRecommended, start]}>
          {t(`onboarding.sleep.recommended.${gender}`)}
        </Text>
        <Text style={[styles.insightFit, start]}>
          {t(`onboarding.sleep.fit.${fit}`, { hours: String(hours) })}
        </Text>
      </View>
    </View>
  );
}

/**
 * Where they are, and what they spend.
 *
 * One question, two stored answers. Picking a country sets the currency with
 * it, because that is the answer in all but a handful of cases; "somewhere
 * else" drops to a plain currency list rather than making someone claim a
 * country they are not in.
 */
export function CountryPicker({
  country,
  currency,
  onChange,
  surface = colors.surface,
}: {
  country: string | null;
  currency: string | null;
  onChange: (next: { country: string | null; currency: string | null }) => void;
  surface?: string;
}) {
  const showCurrencies = country === null;

  return (
    <View>
      <View style={styles.chipWrap}>
        {COUNTRIES.map((c) => {
          const active = country === c.code;
          return (
            <Pressable
              key={c.code}
              onPress={() => {
                tap();
                onChange({ country: c.code, currency: currencyOf(c.code) });
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[styles.countryChip, { backgroundColor: active ? colors.primary : surface }]}
            >
              <Text style={styles.countryFlag}>{c.flag}</Text>
              <Text style={[styles.chipText, active && styles.chipTextActive]}>
                {t(`country.${c.code}`)}
              </Text>
            </Pressable>
          );
        })}
        <Pressable
          onPress={() => {
            tap();
            onChange({ country: null, currency });
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: showCurrencies }}
          style={[
            styles.countryChip,
            { backgroundColor: showCurrencies ? colors.primary : surface },
          ]}
        >
          <Text style={[styles.chipText, showCurrencies && styles.chipTextActive]}>
            {t('country.other')}
          </Text>
        </Pressable>
      </View>

      {/* Only when no country carries the answer already. */}
      {showCurrencies ? (
        <>
          <Text style={[styles.railLabelSmall, { textAlign: alignStart() }]}>
            {t('onboarding.place.currency')}
          </Text>
          <View style={styles.chipWrap}>
            {CURRENCIES.map((code) => {
              const active = currency === code;
              return (
                <Pressable
                  key={code}
                  onPress={() => {
                    tap();
                    onChange({ country: null, currency: code });
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={[styles.chip, { backgroundColor: active ? colors.primary : surface }]}
                >
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {currencySymbol(code, locale())} {code}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  countryChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 50,
  },
  countryFlag: { fontSize: 15 },
  railLabelSmall: {
    ...font(600),
    fontSize: 13,
    color: colors.textMuted,
    marginTop: spacing.md,
    marginBottom: 8,
  },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: 50,
  },
  chipText: { ...font(600), fontSize: 14, color: colors.text },
  chipTextActive: { color: colors.primaryText },

  railLabel: { ...font(700), fontSize: 20, color: colors.text, marginBottom: 6 },
  hourRail: { gap: 8, paddingBottom: spacing.md },
  hourChip: {
    minWidth: 58,
    paddingHorizontal: 12,
    paddingVertical: 11,
    borderRadius: 14,
    alignItems: 'center',
  },
  hourText: { ...font(600), fontSize: 14, color: colors.textMuted },
  hourTextActive: { color: colors.text },

  genderRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  genderCard: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 18,
    borderRadius: radius.md,
  },
  genderLabel: { ...font(600), fontSize: 14, color: colors.textMuted },
  genderLabelActive: { color: colors.text },
  genderSkipText: {
    ...font(600),
    fontSize: 12.5,
    color: colors.textMuted,
    textAlign: 'center',
    paddingVertical: 4,
  },
  genderSkipTextActive: { color: colors.text, textDecorationLine: 'underline' },

  insightCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: radius.md,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  insightIcon: {
    width: 40,
    height: 40,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insightRecommended: { ...font(600), fontSize: 14, color: colors.text, lineHeight: 19 },
  insightFit: { ...font(500), fontSize: 13, color: colors.textMuted, marginTop: 3 },
});
