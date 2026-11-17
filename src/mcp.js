// A minimal MCP server core (JSON-RPC 2.0, protocol 2025-06-18) exposing Jarvis as
// tools, so Vex's agent (or any MCP client) can hand it work. Transport lives in
// server.js; this file only maps requests to tools.
import fs from 'node:fs';
import path from 'node:path';

const PROTOCOL = '2025-06-18';

export function createMcp({ escalator, memory, skills, guard, dir }) {
  const tools = [
    {
      name: 'jarvis_escalate',
      description: 'Raise an alert. Jarvis decides how loud to be (inbox, push, call) from its policy.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string' }, body: { type: 'string' }, severity: { type: 'string', enum: ['info', 'low', 'normal', 'high', 'critical'] }, amount: { type: 'number' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['title'],
      },
      run: async (a) => {
        const out = await escalator.ingest({ source: 'mcp', kind: 'escalate', ...a });
        return `${out.tier}: ${out.reasons.join('; ')}`;
      },
    },
    {
      name: 'jarvis_inbox',
      description: 'List unread inbox items (alerts Jarvis held for you).',
      inputSchema: { type: 'object', properties: {} },
      run: async () => {
        const file = path.join(dir, 'inbox.jsonl');
        if (!fs.existsSync(file)) return 'Inbox is empty.';
        const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => !r.acked).slice(-20);
        return rows.length ? rows.map((r) => `${r.id}  [${r.tier}] ${r.title}`).join('\n') : 'Inbox is empty.';
      },
    },
    {
      name: 'jarvis_ack',
      description: 'Acknowledge an alert so it stops climbing the ladder.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      run: async ({ id }) => (escalator.ack(id) ? 'Acknowledged.' : 'No pending alert with that id.'),
    },
    {
      name: 'jarvis_remember',
      description: 'Store a fact about the person or their world.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      run: async ({ text }) => `Saved ${memory.remember({ kind: 'fact', text }).id}`,
    },
    {
      name: 'jarvis_recall',
      description: 'Search memory (facts, decisions, episodes).',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      run: async ({ query }) => memory.recall(query).map((r) => `[${r.entry.kind}] ${r.entry.text}`).join('\n') || 'Nothing found.',
    },
    {
      name: 'jarvis_decided',
      description: 'Check whether the person already answered this question before asking them again.',
      inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
      run: async ({ question }) => {
        const d = memory.decided(question);
        return d ? `Already decided: ${d.answer}${d.why ? ` (why: ${d.why})` : ''}` : 'No earlier decision matches.';
      },
    },
    {
      name: 'jarvis_record_decision',
      description: 'Record the answer the person just gave so it is never asked again.',
      inputSchema: { type: 'object', properties: { question: { type: 'string' }, answer: { type: 'string' }, why: { type: 'string' } }, required: ['question', 'answer'] },
      run: async (a) => `Recorded ${memory.decide(a).id}`,
    },
    {
      name: 'jarvis_expect_login',
      description: 'Tell the security guard you are about to sign in to a service, so its code is not flagged.',
      inputSchema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] },
      run: async ({ service }) => {
        guard.expectLogin(service);
        return `Expecting a ${service} code for 10 minutes.`;
      },
    },
    {
      name: 'jarvis_skills_pending',
      description: 'List skills Jarvis proposed after learning from a failure. A person must approve them.',
      inputSchema: { type: 'object', properties: {} },
      run: async () => skills.pending().map((s) => `${s.id}: ${s.description}`).join('\n') || 'No pending skills.',
    },
  ];
  const byName = new Map(tools.map((t) => [t.name, t]));

  return {
    tools,
    async handle(msg) {
      if (!msg || msg.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
      const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result });
      const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
      if (msg.id === undefined) return null; // a notification needs no answer

      switch (msg.method) {
        case 'initialize':
          return reply({ protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'jarvis-core', version: '0.1.0' } });
        case 'tools/list':
          return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
        case 'tools/call': {
          const tool = byName.get(msg.params?.name);
          if (!tool) return fail(-32602, `Unknown tool ${msg.params?.name}`);
          try {
            const text = await tool.run(msg.params.arguments || {});
            return reply({ content: [{ type: 'text', text: String(text) }] });
          } catch (err) {
            return reply({ isError: true, content: [{ type: 'text', text: err.message }] });
          }
        }
        case 'ping':
          return reply({});
        default:
          return fail(-32601, `Method not found: ${msg.method}`);
      }
    },
  };
}
