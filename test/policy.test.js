import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, record, newState, inQuietHours, validatePolicy, DEFAULT_POLICY } from '../src/policy.js';
import { at } from './helpers.js';

const policy = { ...DEFAULT_POLICY, timezone: 'UTC', quietHours: { start: '23:00', end: '07:00' } };
const day = at(12);

test('severity sets the floor', () => {
  assert.equal(decide({ source: 's', kind: 'k', title: 'a', severity: 'info' }, policy, newState(), day).tier, 'inbox');
  assert.equal(decide({ source: 's', kind: 'k', title: 'b', severity: 'high' }, policy, newState(), day).tier, 'push');
  assert.equal(decide({ source: 's', kind: 'k', title: 'c', severity: 'critical' }, policy, newState(), day).tier, 'call');
});

test('"call me only over $2000" is a rule, not a vibe', () => {
  const small = decide({ source: 'stripe', kind: 'refund', title: 'refund', amount: 1999 }, policy, newState(), day);
  const big = decide({ source: 'stripe', kind: 'refund', title: 'refund big', amount: 2000 }, policy, newState(), day);
  assert.equal(small.tier, 'inbox');
  assert.equal(big.tier, 'call');
  assert.equal(big.ladder, true);
});

test('quiet hours hold loud events but never critical ones', () => {
  const night = at(2);
  assert.equal(inQuietHours(night, policy), true);
  assert.equal(inQuietHours(day, policy), false);
  const held = decide({ source: 's', kind: 'k', title: 'big', amount: 5000 }, policy, newState(), night);
  assert.equal(held.tier, 'inbox');
  assert.match(held.reasons.join(' '), /quiet hours/);
  const crit = decide({ source: 's', kind: 'k', title: 'hijack', severity: 'critical', tags: ['security'] }, policy, newState(), night);
  assert.equal(crit.tier, 'call');
});

test('quiet hours use the configured time zone, not the machine', () => {
  const istanbul = { ...policy, timezone: 'Europe/Istanbul' }; // UTC+3
  // 21:30 UTC is 00:30 in Istanbul: quiet. 12:00 UTC is 15:00: not quiet.
  assert.equal(inQuietHours(at(21, 30), istanbul), true);
  assert.equal(inQuietHours(at(12), istanbul), false);
});

test('a ceiling rule silences noise but cannot silence a critical event', () => {
  const noisy = decide({ source: 'mail', kind: 'k', title: 'sale', severity: 'high', tags: ['promo'] }, policy, newState(), day);
  assert.equal(noisy.tier, 'silent');
  const crit = decide({ source: 'mail', kind: 'k', title: 'sale2', severity: 'critical', tags: ['promo'] }, policy, newState(), day);
  assert.equal(crit.tier, 'call');
});

test('duplicates inside the window are silent, and a different title is not a duplicate', () => {
  const e = { source: 's', kind: 'k', title: 'same', severity: 'high' };
  let state = newState();
  const first = decide(e, policy, state, day);
  assert.equal(first.tier, 'push');
  state = record(state, first, day);
  assert.equal(decide(e, policy, state, at(12, 10)).tier, 'silent');
  assert.equal(decide({ ...e, title: 'other' }, policy, state, at(12, 10)).tier, 'push');
  assert.equal(decide(e, policy, state, at(13, 0)).tier, 'push', 'window has passed');
});

test('budgets downgrade one rung instead of dropping the event', () => {
  const p = { ...policy, budgets: { pushPerHour: 2, callPerDay: 1 } };
  let state = newState();
  for (let i = 0; i < 2; i++) {
    const d = decide({ source: 's', kind: 'k', title: `p${i}`, severity: 'high' }, p, state, day);
    assert.equal(d.tier, 'push');
    state = record(state, d, day);
  }
  const over = decide({ source: 's', kind: 'k', title: 'p3', severity: 'high' }, p, state, day);
  assert.equal(over.tier, 'inbox');

  let s2 = newState();
  const c1 = decide({ source: 's', kind: 'k', title: 'c1', severity: 'critical' }, p, s2, day);
  assert.equal(c1.tier, 'call');
  s2 = record(s2, c1, day);
  const c2 = decide({ source: 's', kind: 'k', title: 'c2', severity: 'critical' }, p, s2, day);
  assert.equal(c2.tier, 'push', 'second call in a day becomes a push');
});

test('decide does not mutate state', () => {
  const state = newState();
  decide({ source: 's', kind: 'k', title: 'x', severity: 'high' }, policy, state, day);
  assert.deepEqual(state, newState());
});

test('validatePolicy catches mistakes that would silence alerts', () => {
  assert.deepEqual(validatePolicy(DEFAULT_POLICY), []);
  const errs = validatePolicy({ timezone: 'Mars/Base', quietHours: { start: '25:00', end: '07:00' }, rules: [{ name: 'x', tier: 'shout', when: { textMatches: '(' } }], severityFloor: { urgent: 'push' } });
  assert.equal(errs.length >= 4, true, errs.join('|'));
});

test('a per-event dedupe window lets a daily reminder stay quiet between beats', () => {
  const e = { source: 'renewal-guard', kind: 'renewal', title: 'Ahrefs renews', severity: 'high', dedupeWindowMs: 24 * 3600 * 1000 };
  let state = newState();
  const first = decide(e, policy, state, at(9));
  state = record(state, first, at(9));
  assert.equal(decide(e, policy, state, at(20)).tier, 'silent', 'still the same day');
  assert.equal(decide({ ...e, dedupeWindowMs: 24 * 3600 * 1000 }, policy, state, at(9, 0, 18)).tier, 'push', 'next day it speaks again');
});
