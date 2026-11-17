// Escalation policy: decides how loudly an event may speak. Pure functions only,
// so the rules can be read, argued with and tested without a clock or a network.
//
// The ladder, quietest first:
//   silent  nothing is shown (logged only)
//   inbox   waits in the inbox for the next time you look
//   push    a phone/desktop notification
//   call    a voice call (the loudest thing Jarvis can do)
//
// Design rules taken from what people actually build:
//   * "Only interrupt me when it matters": thresholds on amount and severity.
//   * Quiet hours cap the loudest tiers unless the event is critical.
//   * An interrupt budget stops a noisy source from burning your attention.
//   * Duplicates inside a window are silent.
//   * An unacknowledged push climbs one rung after a timeout (see escalator.js).

export const TIERS = ['silent', 'inbox', 'push', 'call'];
const SEVERITIES = ['info', 'low', 'normal', 'high', 'critical'];

export const DEFAULT_POLICY = {
  timezone: 'UTC',
  quietHours: { start: '23:00', end: '07:00' },
  // Budgets are per rolling window; exceeding one downgrades the tier by one rung.
  budgets: { pushPerHour: 6, callPerDay: 2 },
  dedupeWindowMs: 30 * 60 * 1000,
  // Unacked push becomes a call after this long (only for events whose ladder allows it).
  ackTimeoutMs: 10 * 60 * 1000,
  // Severity alone sets the floor; rules can only raise it (never lower it).
  severityFloor: { info: 'inbox', low: 'inbox', normal: 'inbox', high: 'push', critical: 'call' },
  rules: [
    { name: 'big-money', when: { minAmount: 2000 }, tier: 'call', ladder: true },
    { name: 'security', when: { tags: ['security'] }, tier: 'push', breakQuiet: true, ladder: true },
    { name: 'noise', when: { tags: ['newsletter', 'promo'] }, tier: 'silent', ceiling: true },
  ],
};

export function tierIndex(tier) {
  const i = TIERS.indexOf(tier);
  if (i < 0) throw new Error(`Unknown tier "${tier}"`);
  return i;
}

export function maxTier(a, b) {
  return tierIndex(a) >= tierIndex(b) ? a : b;
}

export function minTier(a, b) {
  return tierIndex(a) <= tierIndex(b) ? a : b;
}

function lowerOne(tier) {
  return TIERS[Math.max(0, tierIndex(tier) - 1)];
}

function severityIndex(sev) {
  const i = SEVERITIES.indexOf(sev || 'normal');
  return i < 0 ? 2 : i;
}

/** Minutes since local midnight in `timeZone`. */
export function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const h = Number(parts.find((p) => p.type === 'hour').value);
  const m = Number(parts.find((p) => p.type === 'minute').value);
  return h * 60 + m;
}

function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text));
  if (!m) throw new Error(`Bad time "${text}", expected HH:MM`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Bad time "${text}"`);
  return h * 60 + min;
}

export function inQuietHours(date, policy) {
  const q = policy.quietHours;
  if (!q) return false;
  const start = parseHHMM(q.start);
  const end = parseHHMM(q.end);
  if (start === end) return false;
  const now = localMinutes(date, policy.timezone);
  return start < end ? now >= start && now < end : now >= start || now < end;
}

function ruleMatches(when, event) {
  if (!when) return true;
  if (when.source && when.source !== event.source) return false;
  if (when.kind && when.kind !== event.kind) return false;
  if (when.tags && !when.tags.some((t) => (event.tags || []).includes(t))) return false;
  if (when.minAmount !== undefined && !(Number(event.amount) >= when.minAmount)) return false;
  if (when.minSeverity && severityIndex(event.severity) < severityIndex(when.minSeverity)) return false;
  if (when.textMatches) {
    let re;
    try {
      re = new RegExp(when.textMatches, 'i');
    } catch (err) {
      throw new Error(`Rule has an invalid textMatches pattern: ${when.textMatches}`, { cause: err });
    }
    if (!re.test(`${event.title || ''} ${event.body || ''}`)) return false;
  }
  return true;
}

export function newState() {
  return { pushes: [], calls: [], seen: {} };
}

function prune(list, now, windowMs) {
  return list.filter((t) => now - t < windowMs);
}

/**
 * Decide what to do with one event.
 * Returns { tier, reasons, ladder, dedupeKey }. Never mutates `state`; call
 * `record()` with the result once the decision has been acted on.
 */
export function decide(event, policy, state, now = new Date()) {
  const p = { ...DEFAULT_POLICY, ...policy };
  const reasons = [];
  const t = now.getTime();
  const dedupeKey = event.dedupeKey || `${event.source}:${event.kind}:${event.title}`;

  const seenAt = state.seen[dedupeKey];
  const windowMs = Number.isFinite(event.dedupeWindowMs) ? event.dedupeWindowMs : p.dedupeWindowMs;
  if (seenAt !== undefined && t - seenAt < windowMs) {
    return { tier: 'silent', reasons: ['duplicate inside the dedupe window'], ladder: false, dedupeKey };
  }

  let tier = p.severityFloor[event.severity || 'normal'] || 'inbox';
  reasons.push(`severity ${event.severity || 'normal'} sets the floor to ${tier}`);

  let ceiling = null;
  let breakQuiet = event.severity === 'critical';
  let ladder = false;

  for (const rule of p.rules) {
    if (!ruleMatches(rule.when, event)) continue;
    if (rule.ceiling) {
      ceiling = ceiling ? minTier(ceiling, rule.tier) : rule.tier;
      reasons.push(`rule "${rule.name}" caps this at ${rule.tier}`);
      continue;
    }
    const raised = maxTier(tier, rule.tier);
    if (raised !== tier) reasons.push(`rule "${rule.name}" raises it to ${raised}`);
    tier = raised;
    if (rule.breakQuiet) breakQuiet = true;
    if (rule.ladder) ladder = true;
  }

  // A ceiling rule wins over everything except a critical event.
  if (ceiling && event.severity !== 'critical') {
    tier = minTier(tier, ceiling);
  }

  if (!breakQuiet && inQuietHours(now, p) && tierIndex(tier) > tierIndex('inbox')) {
    reasons.push('quiet hours: held in the inbox');
    tier = 'inbox';
    ladder = false;
  }

  // Interrupt budgets: over budget downgrades one rung rather than dropping the event.
  if (tier === 'call') {
    const used = prune(state.calls, t, 24 * 3600 * 1000).length;
    if (used >= p.budgets.callPerDay) {
      reasons.push(`call budget used (${used}/${p.budgets.callPerDay} today): sent as a push`);
      tier = lowerOne(tier);
      ladder = false;
    }
  }
  if (tier === 'push') {
    const used = prune(state.pushes, t, 3600 * 1000).length;
    if (used >= p.budgets.pushPerHour) {
      reasons.push(`push budget used (${used}/${p.budgets.pushPerHour} this hour): held in the inbox`);
      tier = lowerOne(tier);
      ladder = false;
    }
  }

  return { tier, reasons, ladder, dedupeKey };
}

/** Return the next state after acting on a decision. */
export function record(state, decision, now = new Date()) {
  const t = now.getTime();
  const next = {
    pushes: prune(state.pushes, t, 3600 * 1000),
    calls: prune(state.calls, t, 24 * 3600 * 1000),
    seen: {},
  };
  // Keep entries for a week so per-event windows longer than a day still work.
  for (const [k, v] of Object.entries(state.seen)) {
    if (t - v < 7 * 24 * 3600 * 1000) next.seen[k] = v;
  }
  next.seen[decision.dedupeKey] = t;
  if (decision.tier === 'push') next.pushes.push(t);
  if (decision.tier === 'call') next.calls.push(t);
  return next;
}

/** Validate a policy object and fail loudly on mistakes that would silence alerts. */
export function validatePolicy(policy) {
  const errors = [];
  const p = { ...DEFAULT_POLICY, ...policy };
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: p.timezone });
  } catch {
    errors.push(`timezone "${p.timezone}" is not a valid IANA zone`);
  }
  if (p.quietHours) {
    try {
      parseHHMM(p.quietHours.start);
      parseHHMM(p.quietHours.end);
    } catch (err) {
      errors.push(err.message);
    }
  }
  for (const [i, rule] of (p.rules || []).entries()) {
    if (!TIERS.includes(rule.tier)) errors.push(`rules[${i}] has unknown tier "${rule.tier}"`);
    if (rule.when && rule.when.textMatches) {
      try {
        new RegExp(rule.when.textMatches);
      } catch {
        errors.push(`rules[${i}] has an invalid textMatches pattern`);
      }
    }
  }
  for (const [sev, tier] of Object.entries(p.severityFloor || {})) {
    if (!SEVERITIES.includes(sev)) errors.push(`severityFloor has unknown severity "${sev}"`);
    if (!TIERS.includes(tier)) errors.push(`severityFloor.${sev} has unknown tier "${tier}"`);
  }
  return errors;
}
