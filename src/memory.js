// Memory with three kinds, because they answer different questions:
//   fact      what is true about the person or their world
//   decision  a question the person already answered, so Jarvis stops re-asking
//   episode   what happened (a run, an alert), for "what did you do last night?"
//
// Search is plain BM25-style keyword scoring: no embeddings, no network, and the
// reason a result matched is always explainable.
import crypto from 'node:crypto';
import path from 'node:path';
import { JsonlLog } from './store.js';

const KINDS = ['fact', 'decision', 'episode'];
const STOP = new Set('a an the and or but to of in on for with this that it is are was be do does did my me i you your please can could would should will we our us of at by as from'.split(' '));

export function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

export class Memory {
  constructor({ dir, maxEntries = 5000, now = () => Date.now() }) {
    this.log = new JsonlLog(path.join(dir, 'memory.jsonl'), { maxLines: maxEntries });
    this.now = now;
  }

  all() {
    // Later lines win: a tombstone or a replacement shares the id of what it overrides.
    const byId = new Map();
    for (const e of this.log.readAll()) byId.set(e.id, e);
    return [...byId.values()].filter((e) => !e.deleted);
  }

  remember({ kind = 'fact', text, tags = [], meta = {} }) {
    if (!KINDS.includes(kind)) throw new Error(`Unknown memory kind "${kind}"`);
    const clean = String(text || '').trim();
    if (!clean) throw new Error('Nothing to remember');
    if (clean.length > 2000) throw new Error('A memory entry is limited to 2000 characters');
    const existing = this.all().find((e) => e.kind === kind && e.text.toLowerCase() === clean.toLowerCase());
    if (existing) return existing;
    const entry = { id: crypto.randomUUID(), kind, text: clean, tags, meta, at: this.now() };
    this.log.append(entry);
    this.log.compact();
    return entry;
  }

  forget(id) {
    const hit = this.all().find((e) => e.id === id);
    if (!hit) return false;
    this.log.append({ id, deleted: true, at: this.now() });
    return true;
  }

  recall(query, { kind, limit = 5, minScore = 0.1 } = {}) {
    const q = tokenize(query);
    if (!q.length) return [];
    const docs = this.all().filter((e) => !kind || e.kind === kind);
    if (!docs.length) return [];
    const toks = docs.map((d) => tokenize(`${d.text} ${(d.tags || []).join(' ')}`));
    const avg = toks.reduce((s, t) => s + t.length, 0) / docs.length || 1;
    const df = new Map();
    for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
    const k1 = 1.4;
    const b = 0.75;
    const scored = docs.map((d, i) => {
      let score = 0;
      const tf = new Map();
      for (const w of toks[i]) tf.set(w, (tf.get(w) || 0) + 1);
      for (const w of q) {
        const f = tf.get(w) || 0;
        if (!f) continue;
        const idf = Math.log(1 + (docs.length - (df.get(w) || 0) + 0.5) / ((df.get(w) || 0) + 0.5));
        score += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * toks[i].length) / avg));
      }
      // Normalise by query length so thresholds mean the same for short and long queries.
      return { entry: d, score: score / q.length };
    });
    return scored
      .filter((s) => s.score >= minScore)
      .sort((a, b2) => b2.score - a.score || b2.entry.at - a.entry.at)
      .slice(0, limit);
  }

  // ---- decisions: stop asking what has been answered ----------------------------------

  decide({ question, answer, why = '' }) {
    if (!question || !answer) throw new Error('A decision needs a question and an answer');
    return this.remember({ kind: 'decision', text: `${question} => ${answer}`, meta: { question, answer, why } });
  }

  /**
   * The best earlier decision for a question, or null. Strict on purpose: a wrong
   * "already decided" is worse than asking twice. Matching is word-set similarity
   * (Jaccard) over the questions themselves, not a search score, because search
   * scores shrink on a small memory and would make the threshold meaningless.
   */
  decided(question, { minSimilarity = 0.7 } = {}) {
    const q = new Set(tokenize(question));
    if (!q.size) return null;
    let best = null;
    for (const e of this.all()) {
      if (e.kind !== 'decision') continue;
      const stored = new Set(tokenize(e.meta.question));
      const shared = [...q].filter((w) => stored.has(w)).length;
      const sim = shared / (q.size + stored.size - shared);
      if (sim >= minSimilarity && (!best || sim > best.sim || (sim === best.sim && e.at > best.entry.at))) best = { sim, entry: e };
    }
    if (!best) return null;
    const m = best.entry.meta;
    return { question: m.question, answer: m.answer, why: m.why, at: best.entry.at };
  }
}
