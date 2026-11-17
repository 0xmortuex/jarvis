# Research: what "I built Jarvis" means in practice

Collected 2026-11-17. About 50 Instagram reels (#jarvisai, #jarvis, #hermesagent, #openclaw and a
search for "jarvis calls me"), plus the Stanford OpenJarvis paper, the Hermes Agent docs and write-ups,
and articles on proactive-agent design. TikTok could not be read: it was logged out and showed a
CAPTCHA, which was not attempted.

## How much to trust this

Almost every reel ends with "comment JARVIS and I'll send you the link", which is lead generation
for a course or community. The capability claims are unverified, and some demos may be staged.
The patterns are still useful because the same ones recur across unrelated creators and match the
open-source projects and the engineering write-ups. Treat a pattern as real when it appears in at
least two independent places. Treat any single number ("162 questions answered", "$4,289 revenue")
as marketing.

## Patterns, most repeated first

### 1. It reaches you; you do not open it
- Calls the owner from the car about something that matters (several creators).
- Texts a nightly update and only calls past a threshold ("don't call me unless it's over $2000").
- Wakes the owner in the morning; calls with a daily brief.
- Gets its own phone number (Twilio, Bland AI) so it can call and text.
- A pocket device on Wi-Fi, falling back to Bluetooth, then Tailscale when away.

Built here: escalation ladder, ntfy / Telegram / Twilio channels, quiet hours, budgets.

### 2. It watches and interrupts only when it matters
- Signals watched: Stripe, inbox, GitHub, ad accounts, subscriptions.
- "Heartbeat" pattern: wake on a timer, check, reply `HEARTBEAT_OK` and say nothing if there is nothing to do. Described independently by several engineering write-ups and used by OpenClaw.
- Escalation triggers belong inside the agent policy (confidence, budget, amount), not in a separate monitor.

Built here: heartbeat with producers, silent by default, policy with thresholds.

### 3. Security and money guard
- A text message with a verification code arrived for a login the owner did not start. The agent noticed, locked things down and phoned the owner.
- A renewal ($4,800) was caught before it charged; "from now on it checks before anything renews".

Built here: SecurityGuard (flags unexpected codes, never stores them), renewal guard. Deliberately
**not** built: automatic password changes or cancellations. Those are the verifier's "confirm" tier.

### 4. Memory that stops it re-asking
- "Remembers every decision, every dead end, every no, so it stopped asking questions already answered."
- Hermes keeps agent-curated memory, session search and a model of the user, in several layers (write-ups disagree on four or five).

Built here: three kinds (fact, decision, episode) and a deliberately strict `decided()` check.

### 5. It improves from its own mistakes
- Hermes Agent: when it makes a mistake it writes a reusable skill; skills improve during use.
- Skill packs (17-skill starter lists, 900+ plugins) are the distribution mechanism.
- Risk: a skill written from a run can carry text a web page planted.

Built here: failure-then-success becomes a *proposal*, a human approves, usage and failures are counted, repeat failures are flagged.

### 6. A separate risk layer
- Trading-agent architecture: signals, then reasoning, then execution, with a risk engine that validates in between.
- A second model that checks every answer was a popular plugin.

Built here: deterministic verifier on every tool call, plus an optional model check that can only
make the system more cautious.

### 7. Ticket to pull request
- Repeated support request becomes a ticket, a coding agent opens a tested PR, the owner reviews.

Not built: needs a coding-agent integration. Jarvis exposes MCP, so Vex or Claude Code can sit on that side.

### 8. Local-first
- Stanford OpenJarvis: five primitives (intelligence, engine, agents, tools and memory, learning), local by default, cloud only when needed; reports local models closing the gap to within a few points.
- Many reels: Ollama, Qwen, GPT-OSS on the owner's machine.

Built here: Ollama-first router that reports which model answered.

### 9. Interfaces people liked
- Push-to-talk (hold Space), double-clap trigger, "goodnight" as a hand-off phrase, an old Echo running "Hey Hermes" through Home Assistant, a 3D office view of agents, VR schematic search.

Not built: voice front doors. Vex already has local speech recognition (whisper.cpp) that could be the front door.

## Sources

Instagram reels read (creator, topic): lukebuildsai (2FA hijack call, subscription cancel, "5 days"), joaquinsalamanca (architecture
narration), joshdwhitehouse (morning run), thespenceryan (ESP32 pocket device), skillwars.ai (OpenJarvis),
ariacodez (Fish Audio push-to-talk), hex.gar (double clap), zoeyos.ai (goodnight hand-off), larossa_tech
(40+ connectors), thecidsama (local computer-control), jasoncooperson (phone number via Bland AI), charliehills
(17 Hermes skills), aiprofitlabdaily (Echo + Hermes Voice), arwazaz (trading agent), drcintas (NotebookLM),
julian.goldie_ (Hermes plugins), aiexplained412 (learns from mistakes), dhaibuilds (Jarvis in ChatGPT, phone call feature).

Web:
- Stanford Scaling Intelligence, OpenJarvis: https://scalingintelligence.stanford.edu/pubs/openjarvis/
- OpenJarvis on Ollama's blog: https://registry.ollama.ai/blog/openjarvis
- Hermes Agent docs: https://hermes-agent.nousresearch.com/docs
- Inside Hermes Agent: https://mranand.substack.com/p/inside-hermes-agent-how-a-self-improving
- Heartbeat pattern: https://www.knowlee.ai/blog/heartbeat-patterns-proactive-ai-agents
- Agent escalation design: https://dev.to/dipbhi/awaithuman-pagerduty-notifications-7d3
- Twilio on proactive outbound agents: https://www.twilio.com/en-us/blog/insights/proactive-ai-agent-outbound-calling
