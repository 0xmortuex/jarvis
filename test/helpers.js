import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-test-'));
}

/** A fetch that records calls and answers from a queue (default 200 ok). */
export function fakeFetch(answers = []) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const a = answers.length ? answers.shift() : { status: 200, body: {} };
    if (a instanceof Error) throw a;
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      json: async () => a.body,
      text: async () => (typeof a.body === 'string' ? a.body : JSON.stringify(a.body)),
    };
  };
  fn.calls = calls;
  return fn;
}

/** 2026-11-17 at the given UTC hour:minute. */
export function at(h, m = 0, day = 17) {
  return new Date(Date.UTC(2026, 10, day, h, m));
}
