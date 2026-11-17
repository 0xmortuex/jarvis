#!/usr/bin/env node
import path from 'node:path';
import { build, homeDir, initHome } from '../src/app.js';
import { JsonlLog } from '../src/store.js';

const HELP = `jarvis <command>

  init                          create ~/.jarvis (or $JARVIS_HOME) with a config and a token
  run                           start the heartbeat and the local server
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
      await app.heartbeat.beat();
      process.on('SIGINT', () => {
        app.heartbeat.stop();
        app.server.close(() => process.exit(0));
      });
      return;
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
