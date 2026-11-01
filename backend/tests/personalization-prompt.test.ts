/**
 * personalization-prompt.test.ts — proves the eight new personalization
 * answers reach the agent's system prompt as actionable lines (not just as
 * stored profile fields). The onboarding is only as valuable as the signal
 * the assistant actually receives.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, profileSchema, type Profile } from '../src/modules/voice/agent.js';

const BASE_INPUT = {
  language: 'he',
  timezone: 'Asia/Jerusalem',
  now: new Date('2026-07-29T09:00:00Z'),
  snapshot: {
    tasks: [],
    events: [],
    shopping: [],
    money: [],
    debts: [],
    budgets: {},
    currency: 'ILS',
  },
};

/** Produce a complete Profile with zod defaults filled in. */
function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return profileSchema.parse(overrides) as Profile;
}

describe('system prompt — eight deeper personalization signals', () => {
  it('surfaces the low-energy window as an actionable instruction', () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({ energyLow: 'afternoon' }),
    });
    expect(prompt).toMatch(/Low-energy window: afternoon/);
    expect(prompt).toMatch(/Avoid loading demanding/);
  });

  it('surfaces the weekend rhythm with its character', () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({ weekendRhythm: 'rest' }),
    });
    expect(prompt).toMatch(/Weekend rhythm: rest/);
    expect(prompt).toMatch(/do not spill weekday leftovers/i);
  });

  it('tells the agent to space meetings when the social battery drains', () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({ socialBattery: 'drains' }),
    });
    expect(prompt).toMatch(/Social battery: drains/);
    expect(prompt).toMatch(/≥20 min between meetings/);
  });

  it('matches suggestion volume to planning density', () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({ planningDensity: 'justNext' }),
    });
    expect(prompt).toMatch(/Planning density: justNext/);
    expect(prompt).toMatch(/one next thing/);
  });

  it("leads with upcoming debits when money mood is 'whatIsComing'", () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({ moneyMood: 'whatIsComing' }),
    });
    expect(prompt).toMatch(/Finance view preference: whatIsComing/);
    expect(prompt).toMatch(/upcoming debits first/);
  });

  it('factors the household in when there are people in it', () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({ household: ['kids', 'partner'] }),
    });
    expect(prompt).toMatch(/Household: kids, partner/);
    expect(prompt).toMatch(/pickups, meals, hosting/i);
  });

  it('adds parking time for a car commute', () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({ commute: 'car' }),
    });
    expect(prompt).toMatch(/Primary transport: car/);
    expect(prompt).toMatch(/add parking/);
  });

  it("stays silent when an answer is 'unspecified' — no false signal", () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({
        energyLow: 'unspecified',
        weekendRhythm: 'unspecified',
        socialBattery: 'unspecified',
        planningDensity: 'unspecified',
        moneyMood: 'unspecified',
        household: [],
        commute: 'unspecified',
      }),
    });
    expect(prompt).not.toMatch(/Low-energy window/);
    expect(prompt).not.toMatch(/Weekend rhythm/);
    expect(prompt).not.toMatch(/Social battery/);
    expect(prompt).not.toMatch(/Planning density/);
    expect(prompt).not.toMatch(/Finance view preference/);
    expect(prompt).not.toMatch(/Household:/);
    expect(prompt).not.toMatch(/Primary transport/);
  });

  it('all seven signals surface together without stepping on each other', () => {
    const prompt = buildSystemPrompt({
      ...BASE_INPUT,
      profile: makeProfile({
        energyLow: 'afterDinner',
        weekendRhythm: 'family',
        socialBattery: 'drains',
        planningDensity: 'shortList',
        moneyMood: 'noSurprises',
        household: ['kids'],
        commute: 'transit',
      }),
    });
    const headers = [
      /Low-energy window: afterDinner/,
      /Weekend rhythm: family/,
      /Social battery: drains/,
      /Planning density: shortList/,
      /Finance view preference: noSurprises/,
      /Household: kids/,
      /Primary transport: transit/,
    ];
    headers.forEach((r) => expect(prompt).toMatch(r));
  });
});
