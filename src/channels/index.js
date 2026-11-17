// Delivery channels. Each is { name, tier, send(message) -> Promise<void> }.
// Secrets come from the environment, never from the config file, and are never
// put in an error message. `fetch` is injected so tests never touch the network.
import path from 'node:path';
import { JsonlLog } from '../store.js';

const MAX_TEXT = 1500;

function clip(text, n = MAX_TEXT) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function need(env, name, channel) {
  const v = env[name];
  if (!v) throw new Error(`The ${channel} channel needs ${name} in the environment`);
  return v;
}

async function okOrThrow(res, channel) {
  if (res.ok) return;
  let detail = '';
  try {
    detail = clip(await res.text(), 200);
  } catch {
    // body unreadable; the status is enough
  }
  throw new Error(`${channel} answered ${res.status}${detail ? `: ${detail}` : ''}`);
}

export function inboxChannel({ dir }) {
  const log = new JsonlLog(path.join(dir, 'inbox.jsonl'));
  return {
    name: 'inbox',
    tier: 'inbox',
    async send(msg) {
      log.append({ id: msg.id, at: msg.at, title: msg.title, body: msg.body, tier: msg.tier, source: msg.source, acked: false });
    },
  };
}

export function consoleChannel({ write = (s) => process.stdout.write(s) } = {}) {
  return {
    name: 'console',
    tier: 'push',
    async send(msg) {
      write(`[jarvis ${msg.tier}] ${msg.title}${msg.body ? ` - ${msg.body}` : ''}\n`);
    },
  };
}

/** ntfy.sh or a self-hosted ntfy server: a plain HTTP POST to a topic URL. */
export function ntfyChannel({ server = 'https://ntfy.sh', topic, fetch, env }) {
  if (!topic) throw new Error('The ntfy channel needs a topic');
  return {
    name: 'ntfy',
    tier: 'push',
    async send(msg) {
      const headers = {
        Title: clip(msg.title, 120).replace(/[\r\n]/g, ' '),
        Priority: msg.tier === 'call' ? '5' : '4',
        Tags: msg.tier === 'call' ? 'rotating_light' : 'bell',
      };
      if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
      const url = `${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`;
      const res = await fetch(url, { method: 'POST', headers, body: clip(msg.body || msg.title) });
      await okOrThrow(res, 'ntfy');
    },
  };
}

export function telegramChannel({ chatId, fetch, env }) {
  if (!chatId) throw new Error('The telegram channel needs a chatId');
  return {
    name: 'telegram',
    tier: 'push',
    async send(msg) {
      const token = need(env, 'TELEGRAM_BOT_TOKEN', 'telegram');
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: clip(`${msg.title}\n${msg.body || ''}`.trim(), 4000), disable_web_page_preview: true }),
      });
      // Do not include the URL (it holds the token) in any error.
      await okOrThrow(res, 'telegram');
    },
  };
}

function xmlEscape(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
}

/** A voice call through Twilio's REST API that reads the message aloud. */
export function twilioCallChannel({ to, from, fetch, env }) {
  if (!to || !from) throw new Error('The twilio call channel needs "to" and "from" numbers');
  return {
    name: 'twilio-call',
    tier: 'call',
    async send(msg) {
      const sid = need(env, 'TWILIO_ACCOUNT_SID', 'twilio-call');
      const token = need(env, 'TWILIO_AUTH_TOKEN', 'twilio-call');
      const spoken = clip(`${msg.title}. ${msg.body || ''}`.trim(), 400);
      const twiml = `<Response><Say>${xmlEscape(spoken)}</Say><Pause length="1"/><Say>Repeating. ${xmlEscape(spoken)}</Say></Response>`;
      const body = new URLSearchParams({ To: to, From: from, Twiml: twiml });
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Calls.json`, {
        method: 'POST',
        headers: {
          authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      await okOrThrow(res, 'twilio-call');
    },
  };
}

/**
 * Build the channel list from config. The inbox is always present: a decision
 * to interrupt must never be the only record that something happened.
 */
export function createChannels(config, { fetch = globalThis.fetch, env = process.env, dir, write } = {}) {
  const list = [inboxChannel({ dir })];
  const c = config.channels || {};
  if (c.console) list.push(consoleChannel({ write }));
  if (c.ntfy) list.push(ntfyChannel({ ...c.ntfy, fetch, env }));
  if (c.telegram) list.push(telegramChannel({ ...c.telegram, fetch, env }));
  if (c.twilioCall) list.push(twilioCallChannel({ ...c.twilioCall, fetch, env }));
  return list;
}
