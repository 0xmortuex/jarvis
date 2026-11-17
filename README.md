# jarvis-core

A small, local-first agent core built from what people actually ship when they say "I built Jarvis".
It does the part a browser or a chat window cannot: **it keeps running, decides what deserves your
attention, and reaches you off the desktop.**

No dependencies. Node 20+. MIT.

## What it does

| Pattern | Where |
| --- | --- |
| **Heartbeat.** Wakes on a timer, checks its producers, and says nothing when nothing happened. | `src/heartbeat.js` |
| **Escalation ladder.** `silent < inbox < push < call`, set by severity, amount, tags and rules. Quiet hours, per-hour and per-day interrupt budgets, de-duplication. An unacknowledged push climbs to a call. | `src/policy.js`, `src/escalator.js` |
| **Reach you anywhere.** Inbox (always), console, ntfy, Telegram, Twilio voice call. | `src/channels/` |
| **Talk back.** Chat in the terminal or by texting a Telegram bot: commands that always work, plus a language model for everything else. | `src/chat.js`, `src/telegram.js` |
| **Decision memory.** Facts, decisions and episodes. Ask "did they already answer this?" before asking again. | `src/memory.js` |
| **Self-written skills, human approved.** A run that failed and then succeeded becomes a *proposed* skill. Nothing is used until you approve it; skills that keep failing are flagged. | `src/skills.js` |
| **Verifier.** Deterministic allow / confirm / deny on every tool call: amounts, hosts, blocked patterns. The model cannot talk its way past it. | `src/verifier.js` |
| **Guards.** Unexpected verification code (someone has your password), subscription renewal warnings. They detect and explain; they never act on an account. | `src/guards.js` |
| **Local-first model routing.** Ollama first, cloud only when the task is hard or local is down; every answer says which one it used. | `src/llm.js` |
| **MCP server.** Vex (or any MCP client) can raise alerts, check decisions and read the inbox. | `src/mcp.js`, `src/server.js` |

The research behind these choices, with sources and an honest note on how much to trust each claim,
is in [`docs/RESEARCH.md`](docs/RESEARCH.md).

## Quick start

```sh
node bin/jarvis.js init            # makes ~/.jarvis (or $JARVIS_HOME): config.json + a private token
node bin/jarvis.js signal "Ahrefs renews tomorrow" --amount 4800 --tag money
node bin/jarvis.js run             # heartbeat + local server on 127.0.0.1:7777
node bin/jarvis.js chat            # talk to it (see "Talking to Jarvis")
npm test
```

`signal` prints the tier it chose and why:

```
call
  - severity normal sets the floor to inbox
  - rule "big-money" raises it to call
```

### Reaching your phone

Edit `~/.jarvis/config.json`. Secrets are read from the environment, never from the file.

```json
{
  "channels": {
    "console": true,
    "ntfy": { "topic": "pick-a-long-random-topic" },
    "telegram": { "chatId": "123456789" },
    "twilioCall": { "to": "+90...", "from": "+1..." }
  }
}
```

| Channel | Environment |
| --- | --- |
| ntfy | `NTFY_TOKEN` (only for a protected topic or server) |
| Telegram | `TELEGRAM_BOT_TOKEN` |
| Twilio call | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` |

A public ntfy.sh topic is readable by anyone who guesses the name. Use a long random topic, or self-host.

### Talking to Jarvis

The terminal and Telegram share one brain (`src/chat.js`), so a message gets the same answer in both.

```sh
node bin/jarvis.js chat                 # a conversation; "exit" to leave
node bin/jarvis.js chat inbox           # one message, one reply
```

A message is handled one of two ways:

- **A command** runs the matching Jarvis tool directly. No model is involved, so these always work:
  `help`, `inbox`, `ack <id>`, `remember <text>`, `recall <query>`, `decide <question> => <answer>`,
  `expect-login <service>`, `skills`. A leading slash is fine (`/inbox`).
- **Anything else** goes to the language model, with the last few turns as context. Without a model
  the reply says so and lists the commands.

A sentence that only starts with a command word ("help me write an email") goes to the model. A
leading slash always means a command.

**The model** is the optional `llm` block in `config.json`. `local` is an Ollama model, `cloud` any
OpenAI-compatible one; local is tried first.

```json
{
  "llm": {
    "tools": false,
    "local": { "model": "your-ollama-model" },
    "cloud": { "model": "gpt-x", "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" }
  }
}
```

Set `"tools": false` for a model that cannot call tools (`ollama show <model>` lists `tools` under
capabilities when it can). Such a model only converses: it is told it has no tools and to point you
at the commands, instead of pretending it read your inbox. With tools on, the model can use the same
tools the MCP server exposes, each call passing the verifier first.

**Telegram.** With `channels.telegram.chatId` set and `TELEGRAM_BOT_TOKEN` in the environment,
`jarvis run` also listens for your messages and replies (add `"listen": false` to only send).

1. In Telegram, message `@BotFather`, send `/newbot`, and copy the token it gives you.
2. Put the token in the environment. On Windows: `setx TELEGRAM_BOT_TOKEN "<token>"`, then open a
   new terminal.
3. Send your new bot any message, then run `node bin/jarvis.js telegram-id` to see your chat id.
4. Add `"telegram": { "chatId": "<that id>" }` under `channels` in `config.json` and restart
   `jarvis run` (with the Windows task: `Stop-ScheduledTask -TaskName Jarvis`, then
   `Start-ScheduledTask -TaskName Jarvis`).

Only the configured chat is obeyed. A bot's name is public, so anyone can write to it; messages from
any other chat are dropped without a reply. The token is never written to a log or an error. If
listening fails (no network, a rejected token), a note lands in the inbox, because the daemon has no
window to show it in.

### The policy

`policy` in `config.json` is plain data. The defaults:

- critical severity calls; high pushes; everything else waits in the inbox
- an amount of 2000 or more calls (change `minAmount`)
- `security`-tagged events push and may break quiet hours
- `newsletter` and `promo` tags are silenced (a critical event is never silenced)
- quiet hours 23:00 to 07:00 in your time zone hold everything below critical
- at most 6 pushes an hour and 2 calls a day; over budget downgrades one rung, it never drops the event
- an unacknowledged push becomes a call after 10 minutes (`jarvis ack <id>` stops it)

`jarvis run` refuses to start on a policy that would silence alerts by mistake (unknown tier,
bad time zone, bad pattern).

### Start at logon (Windows)

Run `node bin/jarvis.js init` first, then:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
Start-ScheduledTask -TaskName Jarvis    # or sign out and back in
```

`scripts/install-autostart.ps1` registers a Task Scheduler task named `Jarvis` for your user. It
does not need admin rights. The task:

- runs `node bin/jarvis.js run` every time you log on, with no window (`conhost.exe --headless`)
- starts node again 30 seconds after it exits with an error, and stops node when you end the task
  (both done by `scripts/run-supervised.ps1`, because Task Scheduler does neither for a program
  that exits with an error code)
- stores the absolute paths to `node.exe` and to this repo, so run the installer again after
  moving the repo or reinstalling Node (it replaces the old task)

Check it with `Get-ScheduledTask -TaskName Jarvis`; stop it with `Stop-ScheduledTask -TaskName Jarvis`.
The hidden task keeps no log. If the server on port 7777 does not come up, run
`node bin/jarvis.js run` in a terminal to see the error.

To stop the daemon and remove the task:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-autostart.ps1
```

It leaves `~/.jarvis` alone.

## Using it from Vex

Vex's MCP client speaks the same protocol (`2025-06-18`, JSON-RPC over HTTP).

1. `node bin/jarvis.js run`
2. In Vex: Settings, MCP Servers, add `http://127.0.0.1:7777/mcp` with the token from `~/.jarvis/token`.
3. Vex's agent can now call `jarvis_escalate`, `jarvis_inbox`, `jarvis_ack`, `jarvis_remember`,
   `jarvis_recall`, `jarvis_decided`, `jarvis_record_decision`, `jarvis_expect_login` and
   `jarvis_skills_pending`.

The other direction works too: Vex can run its own MCP server (off by default) so Jarvis can read
your tabs. That side is not wired up here.

Not verified: I could not run Vex's Electron app while building this, so the Vex connection is
untested. The server itself is covered by an in-process HTTP test that speaks the same JSON-RPC.

### Security model

The server accepts only `POST`, only from loopback host names, never from a browser (`Origin` or
`Sec-Fetch-Site` present), only with the bearer token (constant-time compare), throttles bad tokens
(5 a minute), rate-limits (60 a minute), caps connections and bodies (64 KiB). These are the rules
Vex's own MCP server uses.

Things Jarvis will not do on its own, by design:

- change a password, cancel a plan, send a message or pay (the verifier makes these a human yes)
- copy a verification code anywhere (the guard flags the event without the code)
- use a skill it wrote itself before you approved it
- put a secret in an error message or the audit log

An agent run reads web text. Skills are written from run transcripts, so read a proposed skill
before approving it: a page can try to plant instructions in what a run saw.

## Layout

```
bin/jarvis.js        CLI
src/policy.js        ladder, quiet hours, budgets, dedupe (pure)
src/escalator.js     deliver, audit, climb on no-ack
src/channels/        inbox, console, ntfy, telegram, twilio call
src/memory.js        facts, decisions, episodes (BM25-style search, no network)
src/skills.js        proposals, approval, usage counts
src/verifier.js      allow / confirm / deny
src/guards.js        security guard, renewal guard
src/heartbeat.js     the quiet loop
src/llm.js           ollama + OpenAI-compatible, local-first router
src/agent.js         tool loop with verifier gate and skill learning
src/chat.js          one brain for the terminal and Telegram: commands, then the model
src/telegram.js      the listening half of Telegram (long polling, one allowed chat)
src/mcp.js           MCP tools
src/server.js        local HTTP front door
scripts/             Windows auto-start: install, uninstall, and the supervisor the task runs
test/                66 tests (node --test); the 4 auto-start tests run on Windows only
```

## Not built yet

- Reading mail, calendar or GitHub as producers (the heartbeat takes any `poll()` function; only the renewal ledger is wired)
- Spoken replies and a voice front door
- Calling the agent loop from the heartbeat (chat is the only thing that runs it)
- Asking for a yes or no in chat: a tool the verifier marks "confirm" is declined there, not offered
- Chat history across restarts (the last few turns are kept in memory only)
- A phone number that answers inbound calls
