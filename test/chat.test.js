import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build, initHome } from '../src/app.js';
import { createChat, parseCommand } from '../src/chat.js';
import { createTelegramApi, TelegramListener } from '../src/telegram.js';
import { runAgent } from '../src/agent.js';
import { tmpDir, fakeFetch } from './helpers.js';

const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'jarvis.js');

/** A Jarvis home with the default config plus `extra`, and the app built on it with no network. */
function home(extra = {}, fetch = fakeFetch()) {
  const dir = tmpDir();
  initHome(dir);
  const file = path.join(dir, 'config.json');
  const cfg = { ...JSON.parse(fs.readFileSync(file, 'utf8')), ...extra };
  cfg.policy = { ...cfg.policy, timezone: 'UTC', quietHours: null };
  fs.writeFileSync(file, JSON.stringify(cfg));
  return { dir, fetch, app: build({ dir, env: { TELEGRAM_BOT_TOKEN: 'SECRET-TOKEN' }, fetch, write: () => {} }) };
}

/** A model that answers from a list and records what it was sent. */
function scripted(turns) {
  const calls = [];
  return { calls, chat: async (messages, opts) => (calls.push({ messages: structuredClone(messages), opts }), turns.shift()) };
}

const tgOk = (result) => ({ status: 200, body: { ok: true, result } });
const sentBody = (call) => JSON.parse(call.init.body);

test('chat: commands run the matching Jarvis tool, with no model involved', async () => {
  const { app, fetch } = home();
  const say = (t) => app.chat.reply(t);

  assert.match(await say('remember the router is in the hallway cupboard'), /^Saved /);
  assert.match(await say('recall router'), /\[fact\] the router is in the hallway cupboard/);

  assert.match(await say('decide Renew the Canva plan? => Yes until March'), /^Recorded /);
  assert.equal(app.memory.decided('renew the Canva plan').answer, 'Yes until March');

  const { id } = await app.escalator.ingest({ source: 't', kind: 'k', title: 'Server on fire' });
  assert.match(await say('inbox'), new RegExp(`${id}  \\[inbox\\] Server on fire`));
  assert.equal(await say(`ack ${id}`), 'Acknowledged.');
  assert.equal(await say('inbox'), 'Inbox is empty.');

  assert.match(await say('expect-login github'), /Expecting a github code/);
  assert.equal(await say('skills'), 'No pending skills.');
  assert.match(await say('help'), /^Commands:/);
  assert.equal(fetch.calls.length, 0, 'no command touched the network');
});

test('chat: Telegram-style and phone-keyboard spellings are still commands; bad ones explain themselves', async () => {
  const { app } = home();
  assert.equal(await app.chat.reply('/inbox@my_jarvis_bot'), 'Inbox is empty.');
  assert.equal(await app.chat.reply('Inbox.'), 'Inbox is empty.');
  assert.equal(await app.chat.reply('/ack'), 'Usage: ack <id>');
  assert.match(await app.chat.reply('/teleport now'), /^Unknown command "\/teleport"/);
  assert.match(await app.chat.reply('remember ' + 'x'.repeat(2001)), /^That did not work: .*2000 characters/);
  assert.match(await app.chat.reply('   '), /Send a message/);
});

test('chat: a sentence that merely starts with a command word is not a command', () => {
  for (const sentence of ['help me write an email', 'inbox zero is a myth', 'decide what to eat tonight', 'recall', 'skills are hard to learn', 'hello there']) {
    assert.equal(parseCommand(sentence), null, sentence);
  }
  assert.equal(parseCommand('remember to buy milk').rest, 'to buy milk');
  assert.equal(parseCommand('/help me').name, 'help', 'a slash always means a command');
});

test('chat: with no model configured, a free-form message says so and lists the commands', async () => {
  const { app, fetch } = home();
  const reply = await app.chat.reply('what should I cook tonight?');
  assert.match(reply, /no language model is configured/);
  assert.match(reply, /remember <text>/);
  assert.equal(fetch.calls.length, 0);
});

test('chat: the model sees earlier turns of the same conversation, and conversations stay apart', async () => {
  const { app } = home();
  const llm = scripted([{ content: 'OK.' }, { content: 'Teal.' }, { content: 'I do not know.' }]);
  const chat = createChat({ tools: app.mcp.tools, llm, useTools: false });

  assert.equal(await chat.reply('My favourite colour is teal.', { conversation: 'terminal' }), 'OK.');
  assert.equal(await chat.reply('Which colour?', { conversation: 'terminal' }), 'Teal.');
  await chat.reply('Which colour?', { conversation: 'telegram:42' });

  const roles = (i) => llm.calls[i].messages.map((m) => `${m.role}:${m.content}`).slice(1);
  assert.deepEqual(roles(1), ['user:My favourite colour is teal.', 'assistant:OK.', 'user:Which colour?']);
  assert.deepEqual(roles(2), ['user:Which colour?'], 'the Telegram chat did not inherit the terminal history');
});

test('chat: a model without tools is told so and pointed at the commands; a model with tools can use them', async () => {
  const { app } = home();

  const plain = scripted([{ content: 'Send "inbox".' }]);
  await createChat({ tools: app.mcp.tools, llm: plain, useTools: false }).reply('what is in my inbox?');
  assert.deepEqual(plain.calls[0].opts.tools, []);
  assert.match(plain.calls[0].messages[0].content, /You have no tools/);
  assert.match(plain.calls[0].messages[0].content, /ack <id>/, 'the commands are named so the model can point at them');

  const capable = scripted([{ content: '', toolCalls: [{ name: 'jarvis_remember', args: { text: 'the dentist is on Friday' } }] }, { content: 'Noted.' }]);
  const chat = createChat({ tools: app.mcp.tools, llm: capable, useTools: true, memory: app.memory });
  assert.equal(await chat.reply('note that the dentist is on Friday'), 'Noted.');
  assert.ok(capable.calls[0].opts.tools.some((t) => t.name === 'jarvis_inbox' && t.parameters.type === 'object'));
  assert.equal(app.memory.recall('dentist', { kind: 'fact' }).length, 1, 'the tool really ran');
});

test('chat: a model failure becomes a plain reply, commands keep working, and the failed turn is not remembered', async () => {
  const { app } = home();
  const logs = [];
  const llm = { calls: 0, chat: async (messages) => (llm.calls++ === 0 ? Promise.reject(new Error('No model answered (ECONNREFUSED)')) : { content: `saw ${messages.length} messages` }) };
  const chat = createChat({ tools: app.mcp.tools, llm, useTools: false, logger: (m) => logs.push(m) });

  assert.match(await chat.reply('hello'), /I could not answer that: No model answered \(ECONNREFUSED\)\. Commands still work/);
  assert.equal(logs.length, 1);
  assert.equal(await chat.reply('inbox'), 'Inbox is empty.');
  assert.equal(await chat.reply('hello again'), 'saw 2 messages', 'only the system prompt and the new message');

  const empty = createChat({ tools: app.mcp.tools, llm: scripted([{ content: '  ' }]), useTools: false });
  assert.equal(await empty.reply('hi'), 'The language model returned an empty answer.');
});

test('agent: history sits between the system prompt and the new task, and host instructions join the system prompt', async () => {
  const llm = scripted([{ content: 'done' }]);
  const history = [{ role: 'user', content: 'earlier question' }, { role: 'assistant', content: 'earlier answer' }];
  await runAgent({ task: 'new question', llm, tools: [{ name: 'lookup', description: 'x', run: async () => 'r' }], history, instructions: 'Reply in one line.' });
  const sent = llm.calls[0].messages;
  assert.deepEqual(sent.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
  assert.match(sent[0].content, /Use tools to act/);
  assert.match(sent[0].content, /Reply in one line\./);
  assert.equal(sent[3].content, 'new question');
});

test('app: the llm block in config.json turns on free-form chat, and a broken block is refused at start', async () => {
  const fetch = fakeFetch([{ status: 200, body: { message: { content: 'hi there' } } }]);
  const { app } = home({ llm: { tools: false, local: { model: 'some-model' } } }, fetch);
  assert.equal(await app.chat.reply('hello'), 'hi there');
  assert.equal(fetch.calls[0].url, 'http://127.0.0.1:11434/api/chat');
  const body = sentBody(fetch.calls[0]);
  assert.equal(body.model, 'some-model');
  assert.equal(body.tools, undefined, 'tools: false sends no tool list');

  assert.throws(() => home({ llm: {} }), /needs a "local" or a "cloud" model/);
  assert.throws(() => home({ llm: { local: {} } }), /llm\.local in config\.json needs a "model"/);
});

test('telegram: only the configured chat is answered, and the read position survives to the next poll', async () => {
  const dir = tmpDir();
  const updates = [
    { update_id: 7, message: { chat: { id: 42 }, text: '/inbox' } },
    { update_id: 8, message: { chat: { id: 999 }, text: 'ack everything' } },
    { update_id: 9, message: { chat: { id: 42 }, photo: [{}] } },
    { update_id: 10, edited_message: { chat: { id: 42 }, text: 'ignored kind' } },
  ];
  const fetch = fakeFetch([tgOk(updates), tgOk({}), tgOk({}), tgOk([])]);
  const heard = [];
  const logs = [];
  const chat = { reply: async (text, opts) => (heard.push({ text, ...opts }), `echo: ${text}`) };
  const listener = new TelegramListener({ api: createTelegramApi({ env: { TELEGRAM_BOT_TOKEN: 'SECRET-TOKEN' }, fetch }), chatId: 42, chat, dir, logger: (m) => logs.push(m) });

  assert.equal(await listener.pollOnce({ timeoutSec: 0 }), 4);
  assert.deepEqual(heard, [{ text: '/inbox', conversation: 'telegram:42' }], 'the stranger was never passed to the chat brain');
  assert.equal(logs.length, 1);

  assert.match(fetch.calls[0].url, /\/getUpdates$/);
  assert.equal(sentBody(fetch.calls[0]).offset, 0);
  const sends = fetch.calls.slice(1, 3);
  assert.ok(sends.every((c) => /\/sendMessage$/.test(c.url) && sentBody(c).chat_id === '42'), 'every reply went to the configured chat');
  assert.deepEqual(sends.map((c) => sentBody(c).text), ['echo: /inbox', 'I can only read text messages.']);

  await listener.pollOnce({ timeoutSec: 0 });
  assert.equal(sentBody(fetch.calls[3]).offset, 11, 'the next poll starts after the last update seen');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'telegram.json'), 'utf8')).offset, 11);
});

test('telegram: a message is marked seen before it is handled, so a crash cannot replay a command', async () => {
  const dir = tmpDir();
  const fetch = fakeFetch([tgOk([{ update_id: 3, message: { chat: { id: 42 }, text: 'ack abc' } }]), tgOk([])]);
  const chat = { reply: async () => { throw new Error('disk full'); } };
  const listener = new TelegramListener({ api: createTelegramApi({ env: { TELEGRAM_BOT_TOKEN: 't' }, fetch }), chatId: 42, chat, dir });

  await assert.rejects(() => listener.pollOnce({ timeoutSec: 0 }), /disk full/);
  await listener.pollOnce({ timeoutSec: 0 });
  assert.equal(sentBody(fetch.calls[1]).offset, 4);
});

test('telegram: the bot token never appears in an error, and a missing or rejected token is fatal', async () => {
  const leaky = async (url) => { throw Object.assign(new Error(`fetch failed for ${url}`), { cause: { code: 'ECONNRESET' } }); };
  const down = createTelegramApi({ env: { TELEGRAM_BOT_TOKEN: 'SECRET-TOKEN' }, fetch: leaky });
  const netErr = await down.getUpdates({ timeoutSec: 0 }).catch((e) => e);
  assert.equal(netErr.message, 'telegram getUpdates could not be reached (ECONNRESET)');
  assert.ok(!netErr.fatal);

  const rejected = createTelegramApi({ env: { TELEGRAM_BOT_TOKEN: 'SECRET-TOKEN' }, fetch: fakeFetch([{ status: 401, body: { ok: false, description: 'Unauthorized SECRET-TOKEN' } }]) });
  const authErr = await rejected.sendMessage(42, 'hi').catch((e) => e);
  assert.equal(authErr.message, 'telegram sendMessage answered 401');
  assert.equal(authErr.fatal, true);

  const none = await createTelegramApi({ env: {}, fetch: fakeFetch() }).getUpdates({ timeoutSec: 0 }).catch((e) => e);
  assert.match(none.message, /needs TELEGRAM_BOT_TOKEN/);
  assert.equal(none.fatal, true);

  const refused = fakeFetch([{ status: 200, body: { ok: false } }]);
  await assert.rejects(() => createTelegramApi({ env: { TELEGRAM_BOT_TOKEN: 't' }, fetch: refused }).getUpdates({ timeoutSec: 0 }), /did not succeed/);
});

test('telegram: the listener retries a passing failure with a pause, and stops for good on a fatal one', async () => {
  const problems = [];
  const pauses = [];
  const make = (api) => new TelegramListener({
    api, chatId: 42, chat: { reply: async () => '' }, dir: tmpDir(),
    onProblem: async (message, info) => problems.push({ message, ...info }),
    sleep: async (ms) => pauses.push(ms),
  });

  let polls = 0;
  const flaky = make({
    getUpdates: async () => {
      polls++;
      if (polls <= 2) throw new Error('telegram getUpdates answered 502');
      flaky.stop();
      return [];
    },
  });
  await flaky.start();
  assert.equal(polls, 3);
  assert.deepEqual(pauses, [5000, 10000], 'the pause grows while it keeps failing');
  assert.deepEqual(problems, [{ message: 'telegram getUpdates answered 502', stopped: false }, { message: 'telegram getUpdates answered 502', stopped: false }]);

  problems.length = 0;
  let fatalPolls = 0;
  const dead = make({ getUpdates: async () => { fatalPolls++; throw Object.assign(new Error('telegram getUpdates answered 401'), { fatal: true }); } });
  await dead.start();
  assert.equal(fatalPolls, 1, 'a bad token is not retried');
  assert.deepEqual(problems, [{ message: 'telegram getUpdates answered 401', stopped: true }]);
  assert.equal(dead.running, false);
});

test('app: the Telegram listener exists only when its channel is configured, and its failures land in the inbox', async () => {
  assert.equal(home().app.telegram, null);
  assert.equal(home({ channels: { console: true, telegram: { chatId: '42', listen: false } } }).app.telegram, null);

  const fetch = fakeFetch();
  const { app } = home({ channels: { console: true, telegram: { chatId: '42' } } }, fetch);
  assert.ok(app.telegram instanceof TelegramListener);
  assert.equal(app.telegram.chatId, '42');

  await app.telegram.onProblem('telegram getUpdates answered 401', { stopped: true });
  assert.match(await app.chat.reply('inbox'), /\[inbox\] Jarvis stopped listening on Telegram/);
  assert.equal(fetch.calls.length, 0, 'the note is not sent back out through Telegram');
});

test('cli: "chat <message>" answers once, and "chat" alone answers every line it is given', () => {
  const { dir } = home();
  const run = (args, input) => execFileSync(process.execPath, [bin, ...args], { encoding: 'utf8', input, env: { ...process.env, JARVIS_HOME: dir } });

  assert.equal(run(['chat', 'inbox']), 'Inbox is empty.\n');

  const session = run(['chat'], 'remember the spare key is with Sam\nrecall spare key\nexit\nrecall never reached\n');
  assert.match(session, /jarvis> Saved /);
  assert.match(session, /jarvis> \[fact\] the spare key is with Sam/);
  assert.doesNotMatch(session, /never reached/, '"exit" ends the chat');
});
