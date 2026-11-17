#!/usr/bin/env node
import path from 'node:path';
import readline from 'node:readline';
import { build, homeDir, initHome } from '../src/app.js';
import { JsonlLog } from '../src/store.js';
import { createTelegramApi } from '../src/telegram.js';

const HELP = `jarvis <command>

  init                          create ~/.jarvis (or $JARVIS_HOME) with a config and a token
  run                           start the heartbeat, the local server and the Telegram listener
  chat                          talk to Jarvis in this terminal ("exit" to leave)
  chat <message>                send one message and print the reply
  telegram-id                   list the chats that wrote to your bot, to find your chat id
  signal <title> [--severity s] [--amount n] [--tag t]
                                raise an alert through the policy
  inbox                         show unread alerts
  ack <id>                      acknowledge an alert
  remember <text>               store a fact
  recall <query>                search memory
  decide <question> => <answer> record a decision so you are never asked again
  skills                        list approved and pending skills
  skills approve <id>           approve a proposed skill
  skills reject <id>            delete a proposed skill
  expect-login <service>        tell the security guard a code is coming
`;

function flag(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}` && args[i + 1] !== undefined) {
      out.push(args[i + 1]);
      args.splice(i, 2);
      i--;
    }
  }
  return out;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const dir = homeDir();
  if (!cmd || cmd === 'help' || cmd === '--help') return process.stdout.write(HELP);

  if (cmd === 'init') {
    const made = initHome(dir);
    return process.stdout.write(`Created ${made.config}\nToken is in ${made.token} (keep it private)\n`);
  }

  const app = build({ dir });

  switch (cmd) {
    case 'run': {
      const { host, port } = app.config.server;
      app.server.listen(port, host, () => process.stdout.write(`Jarvis is listening on http://${host}:${port}\n`));
      app.heartbeat.start();
      app.telegram?.start().catch((err) => process.stderr.write(`telegram listener crashed: ${err.message}\n`));
      await app.heartbeat.beat();
      process.on('SIGINT', () => {
        app.heartbeat.stop();
        app.telegram?.stop();
        app.server.close(() => process.exit(0));
      });
      return;
    }
    case 'chat': {
      const say = (text) => app.chat.reply(text, { conversation: 'terminal' });
      if (rest.length) return process.stdout.write(`${await say(rest.join(' '))}\n`);
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'you> ' });
      // Input can end while a reply is still being written (piped input, Ctrl+D). Lines already
      // read are still answered, but a closed readline must not be asked to prompt again.
      let open = true;
      rl.once('close', () => (open = false));
      process.stdout.write('Talking to Jarvis. Type "help" for commands, "exit" to leave.\n');
      rl.prompt();
      for await (const line of rl) {
        const text = line.trim();
        if (text === 'exit' || text === 'quit') break;
        if (text) process.stdout.write(`jarvis> ${await say(text)}\n`);
        if (open) rl.prompt();
      }
      rl.close();
      return;
    }
    case 'telegram-id': {
      // Reading without an offset leaves the messages waiting, so the listener still answers them later.
      const updates = await createTelegramApi({ env: process.env, fetch: globalThis.fetch }).getUpdates({ timeoutSec: 0 });
      const chats = new Map();
      for (const u of updates) {
        const c = u.message?.chat;
        if (c) chats.set(c.id, c);
      }
      if (!chats.size) return process.stdout.write('No messages are waiting. Send your bot any message from your phone, then run this again.\n');
      const lines = [...chats.values()].map((c) => `${c.id}  ${[c.first_name, c.last_name].filter(Boolean).join(' ') || c.title || ''}${c.username ? ` (@${c.username})` : ''}`);
      return process.stdout.write(`${lines.join('\n')}\nPut the id of your own chat in config.json as channels.telegram.chatId.\n`);
    }
    case 'signal': {
      const severity = flag(rest, 'severity')[0];
      const amount = flag(rest, 'amount')[0];
      const tags = flag(rest, 'tag');
      const title = rest.join(' ');
      const out = await app.escalator.ingest({ source: 'cli', kind: 'signal', title, severity, amount: amount === undefined ? undefined : Number(amount), tags });
      return process.stdout.write(`${out.tier}\n${out.reasons.map((r) => `  - ${r}`).join('\n')}\n`);
    }
    case 'inbox': {
      const rows = new JsonlLog(path.join(dir, 'inbox.jsonl')).readAll().filter((r) => !r.acked);
      return process.stdout.write(rows.length ? rows.map((r) => `${r.id}  [${r.tier}] ${r.title}`).join('\n') + '\n' : 'Inbox is empty.\n');
    }
    case 'ack':
      return process.stdout.write(app.escalator.ack(rest[0]) ? 'Acknowledged.\n' : 'No such alert.\n');
    case 'remember':
      return process.stdout.write(`Saved ${app.memory.remember({ kind: 'fact', text: rest.join(' ') }).id}\n`);
    case 'recall': {
      const hits = app.memory.recall(rest.join(' '));
      return process.stdout.write(hits.length ? hits.map((h) => `[${h.entry.kind}] ${h.entry.text}`).join('\n') + '\n' : 'Nothing found.\n');
    }
    case 'decide': {
      const [q, a] = rest.join(' ').split('=>').map((s) => s.trim());
      return process.stdout.write(`Recorded ${app.memory.decide({ question: q, answer: a }).id}\n`);
    }
    case 'skills': {
      const [sub, id] = rest;
      if (sub === 'approve') return process.stdout.write(`Approved as ${app.skills.approve(id)}\n`);
      if (sub === 'reject') return void (app.skills.reject(id), process.stdout.write('Rejected.\n'));
      const out = [...app.skills.list().map((s) => `approved  ${s.name}  (uses ${s.uses || 0}, failures ${s.failures || 0})`), ...app.skills.pending().map((s) => `pending   ${s.id}`)];
      return process.stdout.write(out.length ? out.join('\n') + '\n' : 'No skills yet.\n');
    }
    case 'expect-login':
      app.guard.expectLogin(rest.join(' '));
      return process.stdout.write('Expecting a code for 10 minutes.\n');
    default:
      process.stderr.write(`Unknown command "${cmd}"\n${HELP}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`jarvis: ${err.message}\n`);
  process.exitCode = 1;
});
