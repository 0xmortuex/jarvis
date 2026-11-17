// Model access with local-first routing. Cheap and private by default, the cloud
// only when the task is hard or the local model is down. `fetch` is injected.
//
// Providers speak either the Ollama chat API or an OpenAI-compatible one
// (which covers llama.cpp, vLLM, LM Studio, OpenRouter, and OpenAI itself).

function withTimeout(ms) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, done: () => clearTimeout(t) };
}

async function postJson(fetch, url, body, headers, timeoutMs) {
  const t = withTimeout(timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: t.signal });
    if (!res.ok) throw new Error(`model server answered ${res.status}`);
    return await res.json();
  } finally {
    t.done();
  }
}

function toolsForOpenAI(tools) {
  return tools?.length ? tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters || { type: 'object', properties: {} } } })) : undefined;
}

export function ollamaProvider({ baseUrl = 'http://127.0.0.1:11434', model, fetch, timeoutMs = 120000 }) {
  return {
    name: `ollama:${model}`,
    local: true,
    async chat(messages, { tools } = {}) {
      const data = await postJson(fetch, `${baseUrl}/api/chat`, { model, messages, stream: false, tools: toolsForOpenAI(tools) }, {}, timeoutMs);
      const m = data.message || {};
      return {
        content: m.content || '',
        toolCalls: (m.tool_calls || []).map((c) => ({ name: c.function.name, args: c.function.arguments || {} })),
      };
    },
  };
}

export function openaiProvider({ baseUrl = 'https://api.openai.com/v1', model, apiKeyEnv = 'OPENAI_API_KEY', env, fetch, timeoutMs = 120000 }) {
  return {
    name: `openai:${model}`,
    local: false,
    async chat(messages, { tools } = {}) {
      const key = env[apiKeyEnv];
      if (!key) throw new Error(`Set ${apiKeyEnv} to use the cloud model`);
      const data = await postJson(fetch, `${baseUrl}/chat/completions`, { model, messages, tools: toolsForOpenAI(tools) }, { authorization: `Bearer ${key}` }, timeoutMs);
      const m = data.choices?.[0]?.message || {};
      return {
        content: m.content || '',
        toolCalls: (m.tool_calls || []).map((c) => {
          let args = {};
          try {
            args = JSON.parse(c.function.arguments || '{}');
          } catch {
            throw new Error(`The model sent unreadable arguments for ${c.function.name}`);
          }
          return { name: c.function.name, args };
        }),
      };
    },
  };
}

/**
 * Router: try the local model first unless the task is marked hard; fall back to the
 * other side on error. Which model answered is always reported, so a cloud answer
 * is never mistaken for a local one.
 */
export function createRouter({ local, cloud, log = () => {} }) {
  if (!local && !cloud) throw new Error('Configure at least one model');
  return {
    async chat(messages, opts = {}) {
      const order = opts.hard ? [cloud, local] : [local, cloud];
      const tried = order.filter(Boolean);
      let lastErr;
      for (const p of tried) {
        try {
          const out = await p.chat(messages, opts);
          return { ...out, model: p.name, usedCloud: !p.local };
        } catch (err) {
          lastErr = err;
          log(`model ${p.name} failed: ${err.message}`);
        }
      }
      throw new Error(`No model answered (${lastErr.message})`);
    },
  };
}
