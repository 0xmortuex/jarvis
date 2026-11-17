// Tiny file-backed stores. No dependencies, atomic writes, safe on crash.
import fs from 'node:fs';
import path from 'node:path';

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** A single JSON document, written atomically (tmp file + rename). */
export class JsonStore {
  constructor(file, fallback) {
    this.file = file;
    this.fallback = fallback;
    ensureDir(path.dirname(file));
  }

  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(this.fallback);
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      // Never silently discard a document the person may care about.
      const bad = `${this.file}.corrupt-${Date.now()}`;
      fs.renameSync(this.file, bad);
      throw new Error(`${this.file} was not valid JSON; moved to ${bad}`, { cause: err });
    }
  }

  write(value) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update(fn) {
    const next = fn(this.read());
    this.write(next);
    return next;
  }
}

/** Append-only JSON lines, with a size cap that keeps the newest entries. */
export class JsonlLog {
  constructor(file, { maxLines = 5000 } = {}) {
    this.file = file;
    this.maxLines = maxLines;
    ensureDir(path.dirname(file));
  }

  append(entry) {
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  readAll() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // A torn last line from a crash is expected; skip it.
      }
    }
    return out;
  }

  rewrite(entries) {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  compact() {
    const all = this.readAll();
    if (all.length > this.maxLines) this.rewrite(all.slice(-this.maxLines));
  }
}
