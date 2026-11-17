// Wires everything together from a home directory and a config file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir } from './store.js';
import { DEFAULT_POLICY, validatePolicy } from './policy.js';
import { createChannels } from './channels/index.js';
import { Escalator } from './escalator.js';
import { Memory } from './memory.js';
import { Skills } from './skills.js';
import { SecurityGuard, renewalEvents } from './guards.js';
import { Heartbeat, producer } from './heartbeat.js';
import { createMcp } from './mcp.js';
import { createServer } from './server.js';

export function homeDir(env = process.env) {
  return env.JARVIS_HOME || path.join(os.homedir(), '.jarvis');
}

export function defaultConfig() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return {
    policy: { ...DEFAULT_POLICY, timezone: tz },
    channels: { console: true },
    heartbeatMinutes: 5,
    server: { host: '127.0.0.1', port: 7777 },
    ledgerFile: 'subscriptions.json',
    rules: {},
  };
}

export function initHome(dir) {
  ensureDir(dir);
  const cfg = path.join(dir, 'config.json');
  if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify(defaultConfig(), null, 2), { mode: 0o600 });
  const tok = path.join(dir, 'token');
  if (!fs.existsSync(tok)) fs.writeFileSync(tok, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  return { config: cfg, token: tok };
}

export function loadConfig(dir) {
  const file = path.join(dir, 'config.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file} (run "jarvis init" first)`, { cause: err });
  }
  const errors = validatePolicy(cfg.policy || {});
  if (errors.length) throw new Error(`Policy problems:\n- ${errors.join('\n- ')}`);
  return cfg;
}

export function build({ dir = homeDir(), env = process.env, fetch = globalThis.fetch, write, now } = {}) {
  const config = loadConfig(dir);
  const logger = (m) => (write ? write(`${m}\n`) : process.stderr.write(`${m}\n`));
  const channels = createChannels(config, { fetch, env, dir, write });
  const escalator = new Escalator({ dir, policy: config.policy, channels, logger, ...(now ? { now } : {}) });
  const memory = new Memory({ dir });
  const skills = new Skills({ dir: path.join(dir, 'skills') });
  const guard = new SecurityGuard({ dir });
  const mcp = createMcp({ escalator, memory, skills, guard, dir });

  const producers = [];
  const ledgerPath = path.join(dir, config.ledgerFile || 'subscriptions.json');
  producers.push(
    producer('renewals', () => {
      if (!fs.existsSync(ledgerPath)) return [];
      return renewalEvents(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')));
    }),
  );
  const heartbeat = new Heartbeat({ producers, escalator, intervalMs: (config.heartbeatMinutes || 5) * 60000, logger });

  let token;
  try {
    token = fs.readFileSync(path.join(dir, 'token'), 'utf8').trim();
  } catch (err) {
    throw new Error('Missing token file (run "jarvis init")', { cause: err });
  }
  const server = createServer({ token, escalator, guard, mcp, logger });
  return { config, escalator, memory, skills, guard, mcp, heartbeat, server, token, dir };
}
