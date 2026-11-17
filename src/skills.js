// Skills are procedural memory: a markdown file describing how to do a kind of task.
//
// The learning loop, deliberately gated by a human:
//   1. A run fails, then succeeds. Jarvis writes what changed into a PROPOSAL.
//   2. Nothing is used until the person approves it (`jarvis skills approve <id>`).
//   3. Every use is counted; a skill that keeps failing is flagged for revision
//      instead of being trusted forever.
//
// A skill file looks like:
//   ---
//   name: renew-check
//   description: Check upcoming subscription renewals
//   uses: 4
//   failures: 0
//   ---
//   1. Read the ledger ...
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './store.js';
import { tokenize } from './memory.js';

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

export function slugify(text) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '');
  return NAME_RE.test(s) ? s : `skill-${crypto.randomBytes(3).toString('hex')}`;
}

function parse(text) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('Skill file has no front matter');
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = /^\d+$/.test(kv[2]) ? Number(kv[2]) : kv[2];
  }
  return { meta, body: m[2].trim() };
}

function render(meta, body) {
  const head = Object.entries(meta).map(([k, v]) => `${k}: ${String(v).replace(/\n/g, ' ')}`).join('\n');
  return `---\n${head}\n---\n${body.trim()}\n`;
}

export class Skills {
  constructor({ dir, now = () => new Date() }) {
    this.dir = dir;
    this.proposedDir = path.join(dir, '_proposed');
    this.now = now;
    ensureDir(this.dir);
    ensureDir(this.proposedDir);
  }

  _read(file) {
    const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
    return { ...meta, body, file };
  }

  list() {
    return fs
      .readdirSync(this.dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => this._read(path.join(this.dir, f)));
  }

  pending() {
    return fs
      .readdirSync(this.proposedDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => ({ ...this._read(path.join(this.proposedDir, f)), id: f.replace(/\.md$/, '') }));
  }

  /**
   * Turn a finished run into a proposal. Only runs that hit at least one failure and then
   * succeeded teach anything: a clean first-try success has nothing to learn from.
   */
  proposeFromRun({ task, steps, failures, succeeded }) {
    if (!succeeded) return null;
    if (!failures || !failures.length) return null;
    const name = slugify(task);
    const id = `${name}-${this.now().getTime().toString(36)}`;
    const lines = [
      `Task: ${task}`,
      '',
      '## Steps that worked',
      ...steps.map((s, i) => `${i + 1}. ${s}`),
      '',
      '## Mistakes to avoid',
      ...failures.map((f) => `- ${f}`),
    ];
    const meta = {
      name,
      description: `How to: ${String(task).slice(0, 120)}`,
      uses: 0,
      failures: 0,
      createdBy: 'jarvis',
      proposedAt: this.now().toISOString(),
    };
    fs.writeFileSync(path.join(this.proposedDir, `${id}.md`), render(meta, lines.join('\n')), { mode: 0o600 });
    return id;
  }

  approve(id) {
    const from = path.join(this.proposedDir, `${path.basename(id)}.md`);
    if (!fs.existsSync(from)) throw new Error(`No pending skill "${id}"`);
    const { meta, body } = parse(fs.readFileSync(from, 'utf8'));
    let name = meta.name;
    const target = () => path.join(this.dir, `${name}.md`);
    if (fs.existsSync(target())) name = `${name}-${crypto.randomBytes(2).toString('hex')}`;
    meta.name = name;
    meta.approvedAt = this.now().toISOString();
    fs.writeFileSync(target(), render(meta, body), { mode: 0o600 });
    fs.unlinkSync(from);
    return name;
  }

  reject(id) {
    const from = path.join(this.proposedDir, `${path.basename(id)}.md`);
    if (!fs.existsSync(from)) throw new Error(`No pending skill "${id}"`);
    fs.unlinkSync(from);
  }

  /** Best skills for a task by keyword overlap. Skills flagged for revision rank last. */
  match(task, limit = 3) {
    const q = new Set(tokenize(task));
    if (!q.size) return [];
    return this.list()
      .map((s) => {
        const words = new Set(tokenize(`${s.name} ${s.description} ${s.body}`));
        const hits = [...q].filter((w) => words.has(w)).length;
        const penalty = s.failures >= 3 && s.failures > s.uses / 2 ? 0.5 : 1;
        return { skill: s, score: (hits / q.size) * penalty };
      })
      .filter((x) => x.score >= 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.skill);
  }

  recordUse(name, success) {
    const file = path.join(this.dir, `${path.basename(name)}.md`);
    if (!fs.existsSync(file)) throw new Error(`No skill "${name}"`);
    const { meta, body } = parse(fs.readFileSync(file, 'utf8'));
    meta.uses = (meta.uses || 0) + 1;
    if (!success) meta.failures = (meta.failures || 0) + 1;
    if (meta.failures >= 3 && meta.failures > meta.uses / 2) meta.needsRevision = 'true';
    fs.writeFileSync(file, render(meta, body), { mode: 0o600 });
    return meta;
  }
}
