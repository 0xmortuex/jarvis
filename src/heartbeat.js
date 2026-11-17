// The heartbeat: wake on a timer, ask each producer "anything new?", hand any
// events to the escalator, and say NOTHING when there is nothing. Silence is the
// default; a heartbeat that chatters trains you to ignore it.
export class Heartbeat {
  constructor({ producers = [], escalator, intervalMs = 5 * 60 * 1000, logger = () => {}, setTimer = setInterval, clearTimer = clearInterval }) {
    this.producers = producers;
    this.escalator = escalator;
    this.intervalMs = intervalMs;
    this.log = logger;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.running = false;
  }

  /** One beat. Returns { ok: true } when nothing needed attention. A failing producer never stops the others. */
  async beat() {
    if (this.running) return { skipped: true };
    this.running = true;
    try {
      const events = [];
      for (const p of this.producers) {
        try {
          const found = await p.poll();
          if (Array.isArray(found)) events.push(...found);
        } catch (err) {
          // A dead producer is itself worth knowing about, but only once per beat and quietly.
          events.push({ source: 'heartbeat', kind: 'producer-failed', title: `${p.name || 'a producer'} could not be read`, body: err.message, severity: 'low', dedupeKey: `producer-failed:${p.name}`, dedupeWindowMs: 6 * 3600 * 1000 });
        }
      }
      const results = [];
      for (const e of events) results.push(await this.escalator.ingest(e));
      const climbed = await this.escalator.tick();
      if (!events.length && !climbed.length) {
        this.log('HEARTBEAT_OK');
        return { ok: true };
      }
      return { ok: false, results, climbed };
    } finally {
      this.running = false;
    }
  }

  start() {
    if (this.timer) return;
    this.timer = this.setTimer(() => {
      this.beat().catch((err) => this.log(`heartbeat error: ${err.message}`));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}

/** A producer from a plain function, e.g. () => renewalEvents(ledger). */
export function producer(name, fn) {
  return { name, poll: async () => fn() };
}
