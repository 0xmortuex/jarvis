// Windows auto-start scripts. These run real PowerShell, so they are skipped elsewhere.
// Nothing here touches Task Scheduler: the installer is only asked for its plan (-DryRun).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from './helpers.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = (name) => path.join(repo, 'scripts', name);
const windowsOnly = { skip: process.platform === 'win32' ? false : 'the auto-start scripts are Windows only' };
const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

function powershell(args, options = {}) {
  return execFileSync('powershell.exe', [...PS_FLAGS, ...args], { encoding: 'utf8', timeout: 60000, ...options });
}

function samePath(actual, expected, message) {
  assert.equal(path.normalize(actual).toLowerCase(), path.normalize(expected).toLowerCase(), message);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}

/** Kill a process and everything it started. A process that is already gone is not an error. */
function killTree(pid) {
  if (!alive(pid)) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (err) {
    if (alive(pid)) throw err;
  }
}

async function until(check, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return assert.fail(`Timed out waiting for ${what}`);
}

test('autostart: the installer plans a windowless task with absolute paths to node, the repo and the supervisor', windowsOnly, () => {
  const plan = JSON.parse(powershell(['-File', script('install-autostart.ps1'), '-DryRun']));

  assert.equal(plan.taskName, 'Jarvis');
  samePath(plan.workingDirectory, repo);
  samePath(plan.entry, path.join(repo, 'bin', 'jarvis.js'));
  samePath(plan.supervisor, script('run-supervised.ps1'));
  assert.ok(path.isAbsolute(plan.node) && fs.existsSync(plan.node), 'node is an absolute path that exists');

  assert.ok(path.isAbsolute(plan.execute));
  assert.equal(path.basename(plan.execute).toLowerCase(), 'conhost.exe');
  assert.ok(plan.arguments.startsWith('--headless '), 'headless conhost means no window');
  for (const p of [plan.supervisor, plan.node, plan.entry]) {
    assert.ok(plan.arguments.includes(`"${p}"`), `the task command line carries ${p} in quotes`);
  }
});

test('autostart: every script parses as PowerShell', windowsOnly, () => {
  const files = ['install-autostart.ps1', 'uninstall-autostart.ps1', 'run-supervised.ps1'].map(script);
  const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ');
  const out = powershell([
    '-Command',
    `foreach ($f in @(${list})) { $e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$null, [ref]$e); foreach ($x in $e) { Write-Output ($f + ': ' + $x.Message) } }`,
  ]);
  assert.equal(out.trim(), '');
});

test('autostart: the supervisor restarts node after a failure and ends after a clean exit', windowsOnly, () => {
  const dir = tmpDir();
  const entry = path.join(dir, 'flaky.cjs');
  // Fails on its first run, succeeds on its second, and records the argument it was given each time.
  fs.writeFileSync(
    entry,
    "const fs = require('node:fs'); const path = require('node:path');\n" +
      "const log = path.join(__dirname, 'runs.log');\n" +
      "fs.appendFileSync(log, process.argv[2] + '\\n');\n" +
      "process.exit(fs.readFileSync(log, 'utf8').trim().split('\\n').length < 2 ? 1 : 0);\n",
  );

  powershell(['-File', script('run-supervised.ps1'), '-Node', process.execPath, '-Entry', entry, '-RestartDelaySeconds', '1']);

  assert.deepEqual(fs.readFileSync(path.join(dir, 'runs.log'), 'utf8').trim().split('\n'), ['run', 'run']);
});

test('autostart: the supervisor stops node when its parent process is killed, so ending the task leaves nothing running', windowsOnly, async () => {
  const dir = tmpDir();
  const entry = path.join(dir, 'daemon.cjs');
  const pidFile = path.join(dir, 'pid.txt');
  // Records its own process id and its parent's, which is the supervisor.
  fs.writeFileSync(entry, "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'pid.txt'), process.pid + ' ' + process.ppid); setInterval(() => {}, 1000);\n");

  // cmd.exe stands in for the task's conhost: it is the supervisor's parent, and killing it is
  // what ending the task does. Two things that cannot stand in: a node process (node kills its
  // own children when it dies, which would hide the bug this test is here to catch) and
  // conhost itself (headless conhost quits at once when its input is not a real terminal).
  const quoted = (s) => `"${s}"`;
  const line = ['powershell.exe', ...PS_FLAGS, '-File', quoted(script('run-supervised.ps1')), '-Node', quoted(process.execPath), '-Entry', quoted(entry), '-RestartDelaySeconds', '1'].join(' ');
  const parent = spawn('cmd.exe', ['/d', '/s', '/c', quoted(line)], { stdio: 'ignore', windowsVerbatimArguments: true });

  let ids;
  try {
    ids = await until(() => {
      if (!fs.existsSync(pidFile)) return null;
      const [daemon, supervisor] = fs.readFileSync(pidFile, 'utf8').split(' ').map(Number);
      return daemon > 0 && supervisor > 0 ? { daemon, supervisor } : null;
    }, 30000, 'the supervised node to start');
    assert.ok(alive(ids.daemon) && alive(ids.supervisor));

    parent.kill();
    await until(() => !alive(ids.daemon), 15000, 'the supervisor to stop node after its parent died');
    await until(() => !alive(ids.supervisor), 15000, 'the supervisor to exit after stopping node');
  } finally {
    parent.kill();
    // A supervisor that is still alive would start node again, so it goes first, with its children.
    if (ids) {
      killTree(ids.supervisor);
      killTree(ids.daemon);
    }
  }
});
