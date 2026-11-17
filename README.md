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
src/mcp.js           MCP tools
src/server.js        local HTTP front door
test/                45 tests (node --test)
```

## Not built yet

- Reading mail, calendar or GitHub as producers (the heartbeat takes any `poll()` function; only the renewal ledger is wired)
- Spoken replies and a voice front door
- Calling the agent loop from the CLI or the heartbeat (`runAgent` is tested but not exposed as a command)
- A phone number that answers inbound calls
