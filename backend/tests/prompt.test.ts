/**
 * prompt.test.ts — Unit tests for the system prompt builder (T4.2).
 *
 * These tests are pure (no DB, no HTTP). They inject `now` for
 * deterministic output and verify that every required element appears
 * in the generated prompt string.
 */

import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/modules/chat/prompt.js';

// Fixed reference time: 2026-07-26T10:00:00Z
// Jerusalem (Asia/Jerusalem) is UTC+3 in summer → 13:00 local.
const FIXED_NOW = new Date('2026-07-26T10:00:00Z');

describe('buildSystemPrompt – Hebrew / Jerusalem', () => {
  const prompt = buildSystemPrompt({
    userName: 'גיא',
    language: 'he',
    timezone: 'Asia/Jerusalem',
    now: FIXED_NOW,
  });

  it('contains the UTC ISO timestamp', () => {
    expect(prompt).toContain('2026-07-26T10:00:00.000Z');
  });

  it('contains the local time 13:00 (Jerusalem summer = UTC+3)', () => {
    expect(prompt).toContain('13:00');
  });

  it('contains the IANA timezone', () => {
    expect(prompt).toContain('Asia/Jerusalem');
  });

  it('contains the user name', () => {
    expect(prompt).toContain('גיא');
  });

  it('contains the Hebrew confirmation rule (לפני ביצוע / אישור)', () => {
    // Either key phrase confirms the rule is present
    const hasConfirmRule =
      prompt.includes('לפני ביצוע') || prompt.includes('אישור');
    expect(hasConfirmRule).toBe(true);
  });
});

describe('buildSystemPrompt – English / UTC', () => {
  const prompt = buildSystemPrompt({
    userName: 'Alice',
    language: 'en',
    timezone: 'UTC',
    now: FIXED_NOW,
  });

  it('contains the UTC ISO timestamp', () => {
    expect(prompt).toContain('2026-07-26T10:00:00.000Z');
  });

  it('shows UTC time in local line as well (UTC+0 = same time)', () => {
    // UTC local time should also show 10:00
    expect(prompt).toContain('10:00');
  });

  it('contains the UTC timezone label', () => {
    expect(prompt).toContain('UTC');
  });

  it('contains the user name', () => {
    expect(prompt).toContain('Alice');
  });

  it('is in English (no Hebrew role framing)', () => {
    expect(prompt).toContain("You are the user's personal assistant.");
    expect(prompt).not.toContain('אתה העוזר האישי');
  });

  it('contains the English confirmation rule', () => {
    expect(prompt).toContain('Never execute an action directly');
  });
});

describe('buildSystemPrompt – invalid timezone fallback', () => {
  const prompt = buildSystemPrompt({
    userName: 'Test',
    language: 'en',
    timezone: 'Not/AZone',
    now: FIXED_NOW,
  });

  it('still contains the UTC ISO timestamp', () => {
    expect(prompt).toContain('2026-07-26T10:00:00.000Z');
  });

  it('contains a fallback note mentioning the invalid timezone', () => {
    expect(prompt).toContain('Not/AZone');
    // The fallback note must mention "invalid" or "falling back"
    expect(prompt).toContain('falling back to UTC');
  });

  it('uses UTC as the effective timezone', () => {
    expect(prompt).toContain('User timezone: UTC');
  });
});
