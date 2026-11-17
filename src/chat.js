// One brain for every place you can talk to Jarvis (the terminal, Telegram).
//
// A message is handled in one of two ways:
//   * a COMMAND (inbox, ack, remember, ...) runs the matching Jarvis tool directly.
//     No model is involved, so these always work and always do exactly what they say.
//   * anything else goes to the language model, with the last few turns as context.
//     With no model configured the reply says so instead of guessing.
//
// The commands are thin text fronts for the same tools the MCP server exposes, so
// "inbox" typed in Telegram and jarvis_inbox called by Vex cannot drift apart.
import { runAgent } from './agent.js';

const MAX_TURN_CHARS = 2000;

/** name -> how to turn the text after the command into a tool call. */
const COMMANDS = [
  { name: 'help', usage: 'help', about: 'show this list' },
  { name: 'inbox', usage: 'inbox', about: 'unread alerts', tool: 'jarvis_inbox', args: () => ({}) },
  { name: 'ack', usage: 'ack <id>', about: 'mark an alert as read', tool: 'jarvis_ack', args: (rest) => rest && { id: rest } },
  { name: 'remember', usage: 'remember <text>', about: 'store a fact', tool: 'jarvis_remember', args: (rest) => rest && { text: rest } },
  { name: 'recall', usage: 'recall <query>', about: 'search memory', tool: 'jarvis_recall', args: (rest) => rest && { query: rest } },
  {
    name: 'decide',
    usage: 'decide <question> => <answer>',
    about: 'record a decision so you are never asked again',
    tool: 'jarvis_record_decision',
    args: (rest) => {
      const [question, answer] = rest.split('=>').map((s) => s.trim());
      return question && answer ? { question, answer } : null;
    },
  },
  { name: 'expect-login', usage: 'expect-login <service>', about: 'tell the security guard a code is coming', tool: 'jarvis_expect_login', args: (rest) => rest && { service: rest } },
  { name: 'skills', usage: 'skills', about: 'skills waiting for your approval', tool: 'jarvis_skills_pending', args: () => ({}) },
];

const TAKES_NO_TEXT = new Set(['help', 'inbox', 'skills']);

export const HELP = `Commands:\n${COMMANDS.map((c) => `  ${c.usage.padEnd(30)} ${c.about}`).join('\n')}\nAnything else is answered by the language model, if one is configured.`;

/**
 * Split a message into a command and the text after it, or null when it is not a command.
 * A leading slash always means a command (Telegram style, "/inbox@my_bot" included).
 * Without a slash the first word must be a command used the way a command is used, so that
 * "help me write an email" or "inbox zero is a myth" still reach the model.
 */
export function parseCommand(text) {
  const trimmed = String(text || '').trim();
  const slash = trimmed.startsWith('/');
  const [first = '', ...restWords] = (slash ? trimmed.slice(1) : trimmed).split(/\s+/);
  // "/inbox@my_bot" and a phone keyboard's "Inbox." both mean inbox.
  const name = first.toLowerCase().replace(/@.*$/, '').replace(/[.!?]+$/, '');
  const rest = restWords.join(' ').trim();
  const command = COMMANDS.find((c) => c.name === name);
  if (slash) return { name, rest, command: command || null };
  if (!command) return null;
  if (TAKES_NO_TEXT.has(name)) return rest ? null : { name, rest, command };
  return command.args(rest) ? { name, rest, command } : null;
}

/**
 * @param {object} o
 * @param {Array}  o.tools     the MCP tool list ({ name, description, inputSchema, run })
 * @param {object} [o.llm]     a router from llm.js, or null for commands only
 * @param {boolean} [o.useTools] false for a model that cannot call tools
 */
export function createChat({ tools, llm = null, useTools = true, memory, skills, rules, logger = () => {}, maxHistory = 12 }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  for (const c of COMMANDS) {
    if (c.tool && !byName.has(c.tool)) throw new Error(`The "${c.name}" command needs the ${c.tool} tool, which was not provided`);
  }
  const agentTools = tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema, run: t.run }));
  const histories = new Map();

  async function runCommand({ name, rest, command }) {
    if (!command) return `Unknown command "/${name}".\n${HELP}`;
    if (name === 'help') return HELP;
    const args = command.args(rest);
    if (!args) return `Usage: ${command.usage}`;
    try {
      return String(await byName.get(command.tool).run(args));
    } catch (err) {
      logger(`chat: ${name} failed: ${err.message}`);
      return `That did not work: ${err.message}`;
    }
  }

  async function askModel(text, conversation) {
    if (!llm) return `I only understand commands right now, because no language model is configured.\n${HELP}`;
    const history = histories.get(conversation) || [];
    let out;
    try {
      out = await runAgent({
        task: text,
        llm,
        tools: useTools ? agentTools : [],
        rules,
        memory,
        skills,
        history,
        instructions: useTools ? '' : `For anything that needs the inbox or memory, tell the person to send one of these commands instead:\n${HELP}`,
      });
    } catch (err) {
      logger(`chat: the model run failed: ${err.message}`);
      return `I could not answer that: ${err.message}. Commands still work; send "help" to see them.`;
    }
    const answer = String(out.final || '').trim();
    if (!answer) return 'The language model returned an empty answer.';
    const clip = (s) => s.slice(0, MAX_TURN_CHARS);
    histories.set(conversation, [...history, { role: 'user', content: clip(text) }, { role: 'assistant', content: clip(answer) }].slice(-maxHistory));
    return answer;
  }

  return {
    /** One message in, one reply out. `conversation` keeps the terminal and each Telegram chat apart. */
    async reply(text, { conversation = 'default' } = {}) {
      const clean = String(text || '').trim();
      if (!clean) return 'Send a message, or "help" for the commands.';
      const parsed = parseCommand(clean);
      return parsed ? runCommand(parsed) : askModel(clean, conversation);
    },
  };
}
