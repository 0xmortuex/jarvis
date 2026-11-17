import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Escalator } from '../src/escalator.js';
import { inboxChannel, ntfyChannel, telegramChannel, twilioCallChannel, createChannels } from '../src/channels/index.js';
import { DEFAULT_POLICY } from '../src/policy.js';
import { JsonlLog } from '../src/store.js';
import { tmpDir, fakeFetch, at } from './helpers.js';

const policy = { ...DEFAULT_POLICY, timezone: 'UTC', ackTimeoutMs: 10 * 60 * 1000 };

function rig({ clock = { t: at(12) }, failPush = false } = {}) {
  const dir = tmpDir();
  const sent = [];
  const push = { name: 'phone', tier: 'push', send: async (m) => { if (failPush) throw new Error('offline'); sent.push(['push', m.title]); } };
  const call = { name: 'voice', tier: 'call', send: async (m) => { sent.push(['call', m.title]); } };
  const esc = new Escalator({ dir, policy, channels: [inboxChannel({ dir }), push, call], now: () => clock.t });
  return { dir, esc, sent, clock };
}

test('an inbox event only reaches the inbox', async () => {
  const { esc, sent, dir } = rig();
  const r = await esc.ingest({ source: 's', kind: 'k', title: 'fyi' });
  assert.equal(r.tier, 'inbox');
  assert.deepEqual(sent, []);
  assert.equal(new JsonlLog(path.join(dir, 'inbox.jsonl')).readAll().length, 1);
});

test('a critical event calls AND pushes AND is kept in the inbox', async () => {
  const { esc, sent } = rig();
  const r = await esc.ingest({ source: 's', kind: 'k', title: 'hijack', severity: 'critical' });
  assert.equal(r.tier, 'call');
  assert.deepEqual(sent.map((s) => s[0]).sort(), ['call', 'push']);
  assert.deepEqual(r.delivered.sort(), ['inbox', 'phone', 'voice']);
});

test('a failing channel is reported and never loses the inbox copy', async () => {
  const { esc, dir } = rig({ failPush: true });
  const r = await esc.ingest({ source: 's', kind: 'k', title: 'important', severity: 'high' });
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].channel, 'phone');
  assert.equal(new JsonlLog(path.join(dir, 'inbox.jsonl')).readAll().length, 1);
});

test('silent events are audited but delivered nowhere', async () => {
  const { esc, sent, dir } = rig();
  const r = await esc.ingest({ source: 'm', kind: 'k', title: 'sale', tags: ['promo'] });
  assert.equal(r.tier, 'silent');
  assert.deepEqual(sent, []);
  assert.equal(new JsonlLog(path.join(dir, 'audit.jsonl')).readAll().length, 1);
});

test('an unacknowledged push climbs to a call after the timeout; an ack stops it', async () => {
  const { esc, sent, clock } = rig();
  const a = await esc.ingest({ source: 's', kind: 'k', title: 'server down', severity: 'high', tags: ['security'] });
  const b = await esc.ingest({ source: 's', kind: 'k', title: 'disk full', severity: 'high', tags: ['security'] });
  assert.equal(a.tier, 'push');
  assert.equal(esc.ack(b.id), true);

  clock.t = at(12, 5);
  assert.deepEqual(await esc.tick(), [], 'not due yet');

  clock.t = at(12, 11);
  const climbed = await esc.tick();
  assert.equal(climbed.length, 1);
  assert.equal(climbed[0].tier, 'call');
  assert.ok(sent.some(([k, t]) => k === 'call' && t === 'Unacknowledged: server down'));
  assert.equal(sent.filter(([k, t]) => k === 'call' && /disk full/.test(t)).length, 0, 'acked alert never climbs');
});

test('ack marks the inbox copy as read', async () => {
  const { esc, dir } = rig();
  const r = await esc.ingest({ source: 's', kind: 'k', title: 'read me' });
  assert.equal(esc.ack(r.id), true);
  assert.equal(new JsonlLog(path.join(dir, 'inbox.jsonl')).readAll()[0].acked, true);
  assert.equal(esc.ack('nope'), false);
});

test('an event without a title is rejected', async () => {
  const { esc } = rig();
  await assert.rejects(() => esc.ingest({ source: 's' }), /needs a title/);
});

test('ntfy sends a plain POST to the topic with priority and no secret in the body', async () => {
  const f = fakeFetch();
  const ch = ntfyChannel({ topic: 'my topic', fetch: f, env: { NTFY_TOKEN: 'tk_secret' } });
  await ch.send({ title: 'Hello\nworld', body: 'body text', tier: 'call' });
  const c = f.calls[0];
  assert.equal(c.url, 'https://ntfy.sh/my%20topic');
  assert.equal(c.init.headers.Priority, '5');
  assert.equal(c.init.headers.Title, 'Hello world');
  assert.equal(c.init.headers.Authorization, 'Bearer tk_secret');
  assert.equal(c.init.body, 'body text');
});

test('telegram keeps the bot token out of errors', async () => {
  const f = fakeFetch([{ status: 401, body: 'unauthorized' }]);
  const ch = telegramChannel({ chatId: '42', fetch: f, env: { TELEGRAM_BOT_TOKEN: 'SECRETTOKEN' } });
  await assert.rejects(() => ch.send({ title: 't', body: 'b' }), (err) => {
    assert.match(err.message, /telegram answered 401/);
    assert.doesNotMatch(err.message, /SECRETTOKEN/);
    return true;
  });
});

test('twilio call escapes the spoken text and needs its credentials', async () => {
  const f = fakeFetch();
  const ch = twilioCallChannel({ to: '+10000000001', from: '+10000000002', fetch: f, env: { TWILIO_ACCOUNT_SID: 'ACx', TWILIO_AUTH_TOKEN: 'tok' } });
  await ch.send({ title: 'Ahrefs <renews> & more', body: 'cancel it' });
  const body = new URLSearchParams(f.calls[0].init.body);
  assert.match(body.get('Twiml'), /Ahrefs &lt;renews&gt; &amp; more/);
  assert.equal(body.get('To'), '+10000000001');
  assert.match(f.calls[0].init.headers.authorization, /^Basic /);

  const bare = twilioCallChannel({ to: '+1', from: '+2', fetch: f, env: {} });
  await assert.rejects(() => bare.send({ title: 't' }), /needs TWILIO_ACCOUNT_SID/);
});

test('createChannels always includes the inbox', () => {
  const list = createChannels({ channels: {} }, { dir: tmpDir(), fetch: fakeFetch(), env: {} });
  assert.deepEqual(list.map((c) => c.name), ['inbox']);
});
