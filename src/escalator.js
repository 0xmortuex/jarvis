// The escalator takes events, asks the policy how loud to be, delivers through
// the channels, and climbs the ladder for anything left unacknowledged.
import crypto from 'node:crypto';
import path from 'node:path';
import { JsonStore, JsonlLog } from './store.js';
import { decide, record, newState, tierIndex, TIERS, DEFAULT_POLICY } from './policy.js';

export class Escalator {
  constructor({ dir, policy = DEFAULT_POLICY, channels, now = () => new Date(), logger = () => {} }) {
    this.dir = dir;
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.channels = channels;
    this.now = now;
    this.log = logger;
    this.state = new JsonStore(path.join(dir, 'policy-state.json'), newState());
    this.pending = new JsonStore(path.join(dir, 'pending.json'), { items: [] });
    this.audit = new JsonlLog(path.join(dir, 'audit.jsonl'));
  }

  /** Every channel at or below the tier (a call also pushes), plus the inbox, which is always kept. */
  channelsFor(tier) {
    const want = tierIndex(tier);
    return this.channels.filter((ch) => ch.name === 'inbox' || tierIndex(ch.tier) <= want);
  }

  async ingest(event) {
    if (!event || typeof event.title !== 'string' || !event.title.trim()) {
      throw new Error('An event needs a title');
    }
    const at = this.now();
    const decision = decide(event, this.policy, this.state.read(), at);
    this.state.write(record(this.state.read(), decision, at));

    const msg = {
      id: event.id || crypto.randomUUID(),
      at: at.toISOString(),
      title: event.title,
      body: event.body || '',
      source: event.source || 'unknown',
      tier: decision.tier,
    };
    this.audit.append({ ...msg, reasons: decision.reasons, ladder: decision.ladder });

    if (decision.tier === 'silent') return { ...decision, id: msg.id, delivered: [] };

    const delivered = [];
    const failed = [];
    for (const ch of this.channelsFor(decision.tier)) {
      try {
        await ch.send(msg);
        delivered.push(ch.name);
      } catch (err) {
        failed.push({ channel: ch.name, error: err.message });
        this.log(`channel ${ch.name} failed: ${err.message}`);
      }
    }
    if (failed.length) this.audit.append({ id: msg.id, failed });

    // A failed delivery on a loud tier must not vanish: the inbox copy is the safety net.
    if (decision.ladder && tierIndex(decision.tier) < tierIndex('call')) {
      this.pending.update((d) => ({
        items: [...d.items, { id: msg.id, event: { ...event, id: msg.id }, tier: decision.tier, since: at.getTime() }],
      }));
    }
    return { ...decision, id: msg.id, delivered, failed };
  }

  /** Mark an event as seen by a human; it will not climb the ladder. */
  ack(id) {
    let found = false;
    this.pending.update((d) => ({
      items: d.items.filter((i) => {
        if (i.id === id) found = true;
        return i.id !== id;
      }),
    }));
    // Mark the inbox copy read too, so "unread" means what it says.
    const inbox = new JsonlLog(path.join(this.dir, 'inbox.jsonl'));
    const rows = inbox.readAll();
    if (rows.some((r) => r.id === id && !r.acked)) {
      found = true;
      inbox.rewrite(rows.map((r) => (r.id === id ? { ...r, acked: true } : r)));
    }
    if (found) this.audit.append({ id, acked: true, at: this.now().toISOString() });
    return found;
  }

  /** Climb one rung for everything that has waited past the ack timeout. */
  async tick() {
    const t = this.now().getTime();
    const due = this.pending.read().items.filter((i) => t - i.since >= this.policy.ackTimeoutMs);
    const results = [];
    for (const item of due) {
      const next = TIERS[Math.min(tierIndex(item.tier) + 1, tierIndex('call'))];
      // Re-run policy at the higher tier so quiet hours and budgets still apply.
      const bumped = {
        ...item.event,
        dedupeKey: `${item.id}:escalated`,
        title: `Unacknowledged: ${item.event.title.replace(/^(Unacknowledged: )+/, '')}`,
        severity: next === 'call' ? 'critical' : 'high',
      };
      this.pending.update((d) => ({ items: d.items.filter((i) => i.id !== item.id) }));
      const res = await this.ingest({ ...bumped, id: undefined });
      this.audit.append({ id: item.id, escalatedTo: res.tier, at: this.now().toISOString() });
      results.push({ id: item.id, tier: res.tier });
    }
    return results;
  }
}
