import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';
import { calendarStats } from '../../frontend/src/lib/stats';
import { estimateCart, unitPrice } from '../../frontend/src/lib/prices';
import { createSpeechActivity } from '../../frontend/src/lib/speechActivity';
import { en } from '../../frontend/src/lib/i18n/en';
import { he } from '../../frontend/src/lib/i18n/he';
import type { Event } from '../../frontend/src/lib/api';

// Exercise the actual preference modules without loading React Native's native
// bridge in Node. Each fixture has isolated modules and persistent local storage.
function clientFixture(saved: Record<string, string> = {}, device = 'en') {
  const values = new Map(Object.entries(saved));
  const attributes: Record<string, string> = {};
  const store = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    multiSet: async (entries: [string, string][]) => { entries.forEach(([k, v]) => values.set(k, v)); },
    removeItem: async (key: string) => { values.delete(key); },
  };
  const globals = { document: {
    documentElement: { setAttribute: (key: string, value: string) => { attributes[key] = value; }, style: {} },
    body: { style: {} },
  } };
  const modules = new Map<string, any>();
  function load(file: string): any {
    const path = resolve(file);
    if (modules.has(path)) return modules.get(path);
    const exports = {};
    modules.set(path, exports);
    const code = ts.transpileModule(readFileSync(path, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const require = (name: string) => {
      if (name === '@react-native-async-storage/async-storage') return { default: store };
      if (name === 'react-native') return { Platform: { OS: 'web' }, I18nManager: { allowRTL() {} } };
      if (name === 'expo-localization') return { getLocales: () => [{ languageCode: device }] };
      if (name.startsWith('.')) return load(resolve(dirname(path), `${name}.ts`));
      throw new Error(`Unexpected dependency: ${name}`);
    };
    new Function('require', 'exports', 'globalThis', code)(require, exports, globals);
    return exports;
  }
  return { values, attributes, load: (file: string) => load(resolve('../frontend/src', file)) };
}

describe('app language and stored preferences', () => {
  it('has Hebrew translations and matching placeholders for every English key', () => {
    for (const key of Object.keys(en)) {
      expect(he, key).toHaveProperty(key);
      const tokens = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort();
      expect(tokens((he as Record<string, string>)[key]), key).toEqual(tokens((en as Record<string, string>)[key]));
    }
  });

  it('migrates an existing Hebrew voice choice to the entire interface on startup', async () => {
    const app = clientFixture({ '@pa/voiceLanguage': 'he', '@pa/language': 'en' });
    const language = app.load('lib/i18n/index.ts');
    await language.loadLanguage();
    expect(language.getLanguage()).toBe('he');
    expect(language.getVoiceLanguage()).toBe('he');
    expect(language.t('tab.home')).toBe(he['tab.home']);
    expect(language.isRTL()).toBe(true);
    expect(app.attributes).toEqual({ dir: 'rtl', lang: 'he' });
  });

  it('switches both ways immediately, notifies the app, and persists after relaunch', async () => {
    const app = clientFixture();
    const language = app.load('lib/i18n/index.ts');
    let updates = 0;
    language.subscribeToLanguage(() => { updates += 1; });
    await language.setLanguage('he');
    expect(language.locale()).toBe('he-IL');
    expect(language.alignStart()).toBe('right');
    expect(language.t('profile.switchToLight')).toBe('מעבר למצב יום');
    const relaunched = clientFixture(Object.fromEntries(app.values)).load('lib/i18n/index.ts');
    await relaunched.loadLanguage();
    expect(relaunched.getLanguage()).toBe('he');
    await language.setLanguage('en');
    expect(language.alignStart()).toBe('left');
    expect(app.attributes.dir).toBe('ltr');
    expect(updates).toBe(2);
  });

  it('uses the device language for a fresh install and keeps older profiles usable', async () => {
    const app = clientFixture({ '@pa/profile': JSON.stringify({ sleepStartHour: 22, fixedCommitments: 'איסוף ילדים' }) }, 'he');
    const language = app.load('lib/i18n/index.ts');
    await language.loadLanguage();
    expect(language.getLanguage()).toBe('he');
    const storage = app.load('lib/storage.ts').storage;
    const profile = await storage.getProfile();
    expect(profile.sleepStartHour).toBe(22);
    expect(profile.fixedCommitments).toBe('איסוף ילדים');
    expect(profile.focusPeriod).toBe('flexible');
    expect(profile.workDays).toEqual([0, 1, 2, 3, 4]);
    expect((await storage.getSettings()).shoppingEstimates).toBe(false);
    profile.primaryGoal = 'lessStress';
    await storage.saveProfile(profile);
    expect((await storage.getProfile()).primaryGoal).toBe('lessStress');
  });

  it('updates theme tokens and cached styles, and restores the saved appearance', async () => {
    const app = clientFixture();
    const theme = app.load('theme.ts');
    const appearance = app.load('lib/appearance.ts');
    const style = theme.themed(() => ({ background: theme.colors.bg }));
    const dark = style.background;
    await appearance.setAppearance('light');
    expect(style.background).not.toBe(dark);
    expect(app.values.get('@pa/appearance')).toBe('light');
    const restart = clientFixture(Object.fromEntries(app.values)).load('lib/appearance.ts');
    expect(await restart.loadAppearance()).toBe('light');
    await appearance.setAppearance('dark');
    expect(style.background).toBe(dark);
  });
});

const event = (title: string, startsAt: string, endsAt: string, deletedAt: string | null = null) =>
  ({ title, startsAt, endsAt, deletedAt } as Event);
const window = { from: '2026-10-19', to: '2026-10-19' };
const stats = (events: Event[]) => calendarStats(events, [], window, (c) => c, String);

describe('where scheduled time goes', () => {
  it('counts overlapping time once and keeps category totals consistent', () => {
    const result = stats([
      event('עבודה', '2026-10-19T09:00:00', '2026-10-19T11:00:00'),
      event('כושר', '2026-10-19T10:00:00', '2026-10-19T12:00:00'),
    ]);
    expect(result.eventCount).toBe(2);
    expect(result.hoursBusy).toBe(3);
    expect(result.byCategory.map((c) => c.value)).toEqual([1.5, 1.5]);
    expect(result.byHour.map((h) => [h.key, h.value])).toEqual([['9', 1], ['10', 1], ['11', 1]]);
  });

  it('clips overnight events to the selected day and splits partial hours', () => {
    const result = stats([
      event('נסיעה', '2026-10-18T23:00:00', '2026-10-19T01:30:00'),
      event('משפחה', '2026-10-19T23:30:00', '2026-10-20T02:00:00'),
    ]);
    expect(result.hoursBusy).toBe(2);
    expect(result.byHour.map((h) => [h.key, h.value])).toEqual([['0', 1], ['1', 0.5], ['23', 0.5]]);
    expect(result.byWeekday).toEqual([{ key: '1', label: '1', value: 2 }]);
  });

  it('does not invent duration for zero-length, invalid, or deleted events', () => {
    expect(stats([
      event('zero', '2026-10-19T10:00:00', '2026-10-19T10:00:00'),
      event('bad', '2026-10-19T10:00:00', 'invalid'),
      event('deleted', '2026-10-19T10:00:00', '2026-10-19T11:00:00', '2026-10-19'),
    ]).hoursBusy).toBe(0);
  });
});

describe('shopping price honesty', () => {
  it('does not assign the old default 15 shekels to an unknown item', () => {
    const item = { name: 'פריט לא מוכר', quantity: null, category: null };
    expect(unitPrice(item)).toBeNull();
    expect(estimateCart([item], 'ILS')).toEqual({ total: 0, items: 1, guessed: 1 });
  });

  it('treats grape juice as a drink and excludes unknown items from totals', () => {
    const juice = { name: 'מיץ ענבים', quantity: null, category: null };
    const fruit = { ...juice, name: 'ענבים' };
    expect(unitPrice(juice)).not.toBe(unitPrice(fruit));
    expect(estimateCart([juice, { ...juice, name: 'פריט לא מוכר' }], 'ILS').total).toBe(unitPrice(juice));
  });
});

describe('speech activity', () => {
  it('ignores silence and isolated noises instead of sending them for transcription', () => {
    const mic = createSpeechActivity();
    expect(mic.sample(-60, 0).heardSpeech).toBe(false);
    expect(mic.sample(-20, 150).heardSpeech).toBe(false);
    expect(mic.sample(-60, 300).heardSpeech).toBe(false);
    expect(mic.sample(-20, 450).heardSpeech).toBe(false);
  });

  it('recognizes sustained speech and measures silence only after it', () => {
    const mic = createSpeechActivity();
    mic.sample(-20, 0);
    expect(mic.sample(-20, 150).heardSpeech).toBe(true);
    mic.sample(-60, 300);
    expect(mic.sample(-60, 1950).quietMs).toBe(1650);
    expect(mic.sample(-20, 2100).quietMs).toBe(0);
  });
});
