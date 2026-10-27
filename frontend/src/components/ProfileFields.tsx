import { Fragment } from 'react';
import { ScrollView, View, Text, StyleSheet } from 'react-native';
import { Entrance, PopIn, Pressable } from './motion';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { Mars, Venus, BedDouble } from 'lucide-react-native';

import { EVENT_TYPES, type EventType, type Gender } from '../lib/storage';
import { COUNTRIES, CURRENCIES, currencyOf, currencySymbol } from '../lib/currency';
import { colors, spacing, font, type AuraKey, AURA, NIGHT, themed } from '../theme';
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
 * Each takes the ground its idle controls sit on. Glass by default — white at
 * a whisper, with a hairline edge — because glass is the one ground that works
 * in both places: straight on the page in onboarding, and inside a glass card
 * in Settings, where it stacks a step brighter than the card around it. An
 * opaque ground from the old light pages would sit on either as a grey slab.
 *
 * The chosen option, wherever it is, is lit in the app's blue — the fill of the
 * chosen day on Home — so "which one did I pick" has one answer app-wide.
 */

/** Offered gaps between meetings, in minutes. */
export const BUFFERS = [0, 10, 15, 30];

/**
 * Offered lead times for task reminders, in minutes. 0 is "exactly at the due
 * minute"; the rest range from a nudge to a full day's notice, so a task can
 * fire the moment it is due or well before, depending on the person.
 */
export const TASK_LEADS = [0, 5, 10, 15, 30, 60, 120, 240, 1440] as const;

const HOURS = Array.from({ length: 24 }, (_, i) => i);

export function hourLabel(hour: number): string {
  return t('onboarding.hour', { hour: String(hour).padStart(2, '0') });
}

function tap(): void {
  Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/**
 * The chosen option's fill: the blue, lit from the top.
 *
 * Its own layer behind the label because a gradient cannot be a background.
 * Rounded itself rather than clipped by the control: clipping on iOS takes the
 * control's glow with it.
 *
 * It springs in as it mounts, and it is only ever mounted on the chosen
 * option, so choosing is what makes the light pop — on whichever chip, hour or
 * card was just picked, and on nothing else. `from` is the scale it starts at:
 * a big card starts nearer its size, or its bounce past the edge is a lurch.
 */
function LitFill({ radius, from }: { radius: number; from?: number }) {
  return (
    <PopIn style={StyleSheet.absoluteFill} from={from}>
      <LinearGradient
        colors={NIGHT.blue}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={[StyleSheet.absoluteFill, { borderRadius: radius }]}
      />
    </PopIn>
  );
}

/** One pill: glass while idle, lit blue once chosen. */
export function Chip({
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
      style={[styles.chip, active ? styles.lit : [styles.idle, { backgroundColor: surface }]]}
    >
      {active ? <LitFill radius={PILL} /> : null}
      <Text style={[styles.chipText, active && styles.chipTextActive]}>{label}</Text>
    </Pressable>
  );
}

/**
 * A horizontal rail of hours, 00 through 23: a glass rail split by hairlines,
 * the chosen hour lit, like the rail of days on Home.
 *
 * The hairlines either side of the chosen hour go clear rather than away, so
 * the cells don't shift under the finger as the choice moves.
 *
 * The rail is a row of its own and a horizontal ScrollView does not inherit
 * the mirrored direction, so in Hebrew and Arabic it is flipped by hand — and
 * each cell flipped back, or the digits inside would read in reverse.
 *
 * `tile` used to tint the chosen hour — green for work, blue for sleep. The
 * chosen thing is blue everywhere now, so it no longer paints anything; it
 * stays in the props because both screens still pass it.
 */
export function HourPicker({
  value,
  onChange,
  surface = NIGHT.card,
}: {
  value: number;
  onChange: (hour: number) => void;
  tile: AuraKey;
  surface?: string;
}) {
  const mirror = isRTL() ? [{ scaleX: -1 as number }] : undefined;
  return (
    // The glass and the rounded clip are on a view around the scroll, not on
    // the scroll itself: on the web `overflow` on a ScrollView overrides the
    // axis it scrolls along, and the rail would stop scrolling.
    <View style={[styles.hourRail, { backgroundColor: surface }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ direction: 'ltr', transform: mirror }}
      >
        {HOURS.map((hour, i) => {
          const active = hour === value;
          const besideOn = active || HOURS[i - 1] === value;
          return (
            <Fragment key={hour}>
              {i > 0 ? (
                <View style={[styles.hourDivider, besideOn && styles.hourDividerClear]} />
              ) : null}
              <Pressable
                onPress={() => {
                  tap();
                  onChange(hour);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.hourCell, { transform: mirror }]}
              >
                {/* No glow here, unlike the chips: the rail clips to its own
                    rounded box, so it would be cut off at the rail's edge. */}
                {active ? <LitFill radius={HOUR_RADIUS} /> : null}
                <Text style={[styles.hourText, active && styles.hourTextActive]}>
                  {hourLabel(hour)}
                </Text>
              </Pressable>
            </Fragment>
          );
        })}
      </ScrollView>
    </View>
  );
}

/** A labelled from-hour and to-hour pair — work hours, or sleeping hours. */
export function HourRangePicker({
  from,
  to,
  onFrom,
  onTo,
  tile,
  surface = NIGHT.card,
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

/**
 * How much notice before a task is due the reminder should fire.
 *
 * Rendered as a horizontal scrollable rail — the "wheel" the sleep and work
 * hour pickers already use — because the options span an order of magnitude
 * (zero to a full day) and a chip grid would wrap awkwardly.
 */
export function TaskLeadPicker({
  value,
  onChange,
  surface = NIGHT.card,
}: {
  value: number;
  onChange: (minutes: number) => void;
  surface?: string;
}) {
  const mirror = isRTL() ? [{ scaleX: -1 as number }] : undefined;
  return (
    <View style={[styles.hourRail, { backgroundColor: surface }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ direction: 'ltr', transform: mirror }}
      >
        {TASK_LEADS.map((minutes, i) => {
          const active = minutes === value;
          const besideOn = active || TASK_LEADS[i - 1] === value;
          return (
            <Fragment key={minutes}>
              {i > 0 ? (
                <View style={[styles.hourDivider, besideOn && styles.hourDividerClear]} />
              ) : null}
              <Pressable
                onPress={() => {
                  tap();
                  onChange(minutes);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.leadCell, { transform: mirror }]}
              >
                {active ? <LitFill radius={HOUR_RADIUS} /> : null}
                <Text style={[styles.hourText, active && styles.hourTextActive]}>
                  {taskLeadLabel(minutes)}
                </Text>
              </Pressable>
            </Fragment>
          );
        })}
      </ScrollView>
    </View>
  );
}

function taskLeadLabel(minutes: number): string {
  if (minutes === 0) return t('onboarding.reminder.onTime');
  if (minutes >= 1440) return t('onboarding.reminder.days', { count: Math.round(minutes / 1440) });
  if (minutes >= 60) return t('onboarding.reminder.hours', { count: Math.round(minutes / 60) });
  return t('onboarding.reminder.minutes', { count: minutes });
}

/** How much room to leave between one thing and the next. */
export function BufferPicker({
  value,
  onChange,
  surface = NIGHT.card,
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
  surface = NIGHT.card,
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
  { key: 'male', Icon: Mars },
  { key: 'female', Icon: Venus },
] as const satisfies readonly { key: Exclude<Gender, 'unspecified'>; Icon: typeof Mars }[];

/**
 * Man / woman / rather not say — asked once, only so the sleep card below can
 * put a number on "how much is recommended for you" instead of a number for
 * nobody in particular. Never required: the third option is a full answer.
 */
export function GenderPicker({
  value,
  onChange,
  surface = NIGHT.card,
}: {
  value: Gender;
  onChange: (gender: Gender) => void;
  surface?: string;
}) {
  return (
    <View>
      <View style={styles.genderRow}>
        {GENDER_OPTIONS.map(({ key, Icon }) => {
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
                active ? styles.lit : [styles.idle, { backgroundColor: surface }],
              ]}
            >
              {active ? <LitFill radius={CARD_RADIUS} from={0.85} /> : null}
              {/* In a view of its own: on the web a bare svg paints beneath a
                  positioned layer drawn before it, and the glyph would sit
                  under the blue it is meant to stand on. */}
              <View>
                <Icon
                  color={active ? colors.primaryText : colors.textMuted}
                  size={26}
                  strokeWidth={2}
                />
              </View>
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
  surface = NIGHT.card,
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
    // Keyed by what it says, so a new reading arrives rather than the words
    // swapping in place: the card rises again each time the answer changes,
    // which is what draws the eye down from the picker to it. A short rise —
    // it is answering a tap, not opening a page.
    <Entrance key={`${gender}-${hours}`} from={10}>
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
    </Entrance>
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
  surface = NIGHT.card,
}: {
  country: string | null;
  currency: string | null;
  onChange: (next: { country: string | null; currency: string | null }) => void;
  surface?: string;
}) {
  const showCurrencies = country === null;
  const idle = [styles.idle, { backgroundColor: surface }];

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
              style={[styles.countryChip, active ? styles.lit : idle]}
            >
              {active ? <LitFill radius={PILL} /> : null}
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
          style={[styles.countryChip, showCurrencies ? styles.lit : idle]}
        >
          {showCurrencies ? <LitFill radius={PILL} /> : null}
          <Text style={[styles.chipText, showCurrencies && styles.chipTextActive]}>
            {t('country.other')}
          </Text>
        </Pressable>
      </View>

      {/* Only when no country carries the answer already.

          It rises in when "somewhere else" is chosen, so the list reads as
          the answer to that tap. An entrance rather than a layout animation:
          the tap that opens it also mounts a lit fill, and a layout
          animation's fade on a newly mounted view would pull at the same
          opacity that fill's pop drives. */}
      {showCurrencies ? (
        <Entrance from={12}>
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
                  style={[styles.chip, active ? styles.lit : idle]}
                >
                  {active ? <LitFill radius={PILL} /> : null}
                  <Text style={[styles.chipText, active && styles.chipTextActive]}>
                    {currencySymbol(code, locale())} {code}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Entrance>
      ) : null}
    </View>
  );
}

/** Chips are pills; the fill behind a chosen one is rounded to match. */
const PILL = 50;
const HOUR_RADIUS = 12;
const CARD_RADIUS = 16;

const styles = themed(() =>
  StyleSheet.create({
    /** An option nobody has picked: a pane of glass with a hairline edge. */
    idle: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
    },
    /**
     * The chosen option under its `LitFill`. The ground is the gradient's lower
     * stop, which is what the glow is cast from on iOS; the edge stays, clear,
     * so choosing an option doesn't change its size by a hairline.
     */
    lit: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
      backgroundColor: NIGHT.blue[1],
      shadowColor: NIGHT.blue[1],
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.5,
      shadowRadius: 10,
      elevation: 6,
    },

    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    countryChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderRadius: PILL,
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
      borderRadius: PILL,
    },
    // One weight either way: a bolder label on the chosen chip would widen it,
    // and the wrap would reflow under the finger that just tapped it.
    chipText: { ...font(600), fontSize: 14, color: colors.textMuted },
    chipTextActive: { color: colors.primaryText },

    railLabel: { ...font(700), fontSize: 20, color: colors.text, marginBottom: 8 },
    /** The glass around the scroll; clips the chosen hour to its rounded ends. */
    hourRail: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      borderRadius: 13,
      overflow: 'hidden',
      marginBottom: spacing.md,
    },
    hourCell: {
      minWidth: 62,
      height: 48,
      paddingHorizontal: 12,
      alignItems: 'center',
      justifyContent: 'center',
    },
    leadCell: {
      minWidth: 90,
      height: 48,
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    hourDivider: { width: 1, marginVertical: 12, backgroundColor: NIGHT.line },
    hourDividerClear: { backgroundColor: 'transparent' },
    hourText: { ...font(600), fontSize: 14.5, color: colors.textMuted },
    hourTextActive: { color: colors.primaryText },

    genderRow: { flexDirection: 'row', gap: 10, marginBottom: 10 },
    genderCard: {
      flex: 1,
      alignItems: 'center',
      gap: 6,
      paddingVertical: 18,
      borderRadius: CARD_RADIUS,
    },
    genderLabel: { ...font(600), fontSize: 14, color: colors.textMuted },
    genderLabelActive: { color: colors.primaryText },
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
      borderRadius: CARD_RADIUS,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: NIGHT.line,
      padding: spacing.md,
      marginTop: spacing.md,
    },
    /** The fit, in its hue: a whisper of it for the ground, the lit ink for the glyph. */
    insightIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    insightRecommended: { ...font(600), fontSize: 14, color: colors.text, lineHeight: 19 },
    insightFit: { ...font(500), fontSize: 13, color: colors.textMuted, marginTop: 3 },
  }),
);
