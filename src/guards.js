// Guards turn raw signals into events worth a decision. They only DETECT and
// explain; they never act on an account. Changing a password or cancelling a
// plan is a verifier "confirm" step a human approves.
import { JsonStore } from './store.js';
import path from 'node:path';

const CODE_RE = /\b(\d{6,8})\b/;
const CODE_WORDS = /(verification|security|login|log-in|sign-in|one[- ]time|otp|passcode|confirm(?:ation)? code|your code)/i;

/**
 * Account-security guard. A one-time code arriving when you did not just ask for
 * one means someone else has your password and is at the second factor.
 * Register what you are about to do with `expectLogin()`; anything else is an alert.
 */
export class SecurityGuard {
  constructor({ dir, now = () => Date.now() }) {
    this.store = new JsonStore(path.join(dir, 'expected-logins.json'), { items: [] });
    this.now = now;
  }

  expectLogin(service, ttlMs = 10 * 60 * 1000) {
    const t = this.now();
    this.store.update((d) => ({
      items: [...d.items.filter((i) => i.until > t), { service: String(service).toLowerCase(), until: t + ttlMs }],
    }));
  }

  _expected(text) {
    const t = this.now();
    const lower = text.toLowerCase();
    return this.store.read().items.some((i) => i.until > t && lower.includes(i.service));
  }

  /** Inspect an inbound text message. Returns an event or null. The code itself is never copied. */
  inspectMessage({ from = '', body = '' }) {
    if (!CODE_RE.test(body) || !CODE_WORDS.test(body)) return null;
    if (this._expected(`${from} ${body}`)) return null;
    return {
      source: 'security-guard',
      kind: 'unexpected-verification-code',
      title: 'A verification code arrived that you did not ask for',
      body:
        `From ${from || 'unknown sender'}. Someone may know your password and be at the second step. ` +
        'Change that account\'s password from a device you trust, then sign out other sessions. Do not share the code.',
      severity: 'critical',
      tags: ['security'],
      dedupeKey: `code:${from}`,
    };
  }
}

/** Renewal guard: warn before a subscription renews, loudest for the big ones. */
export function renewalEvents(ledger, { now = Date.now(), withinDays = 7 } = {}) {
  const events = [];
  for (const sub of ledger) {
    const at = Date.parse(sub.renewsOn);
    if (!Number.isFinite(at)) throw new Error(`Subscription "${sub.name}" has an unreadable renewsOn date`);
    const days = Math.ceil((at - now) / 86400000);
    if (days < 0 || days > withinDays) continue;
    const amount = Number(sub.amount);
    events.push({
      source: 'renewal-guard',
      kind: 'renewal',
      title: `${sub.name} renews in ${days} day${days === 1 ? '' : 's'} for ${sub.currency || ''}${amount}`.replace('  ', ' '),
      body: sub.cancelUrl ? `Cancel here if you do not want it: ${sub.cancelUrl}` : 'No cancel link on file.',
      amount,
      severity: days <= 1 ? 'high' : 'normal',
      tags: ['money'],
      dedupeKey: `renewal:${sub.name}:${sub.renewsOn}`,
      // The heartbeat runs every few minutes; a renewal should speak once a day, not every half hour.
      dedupeWindowMs: 24 * 3600 * 1000,
    });
  }
  return events;
}
