// One local HTTP server with three doors, all behind a bearer token and bound to
// loopback unless you say otherwise:
//   POST /signal   a JSON event from anything (a script, a phone shortcut, a webhook)
//   POST /sms      an inbound text (JSON or form: From, Body) checked by the security guard
//   POST /mcp      MCP over HTTP (JSON-RPC), so Vex's agent can call Jarvis as a tool
import http from 'node:http';
import crypto from 'node:crypto';

const MAX_BODY = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return; // keep draining so the client can read our 413 instead of a reset
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request body is too large'), { status: 413 }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseBody(text, contentType = '') {
  if (!text) return {};
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    return JSON.parse(text);
  } catch (err) {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400, cause: err });
  }
}

function tokenOk(header, token) {
  const given = String(header || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(status === 413 ? { connection: 'close' } : {}) });
  res.end(body);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The front door fails closed, modelled on Vex's own MCP server:
 *  - the Host header must be a loopback name (a DNS-rebinding page sends its own name)
 *  - a request a browser sent (Origin or Sec-Fetch-Site) is refused: no web page may drive Jarvis
 *  - every request needs the bearer token, compared in constant time
 *  - failed tokens are throttled, and there is an overall rate limit and connection cap
 * `allowedHosts` extends the Host list when you deliberately bind beyond loopback.
 */
export function createServer({ token, escalator, guard, mcp, logger = () => {}, now = () => Date.now(), allowedHosts = [], limits = {} }) {
  if (!token || token.length < 16) throw new Error('The server needs a token of at least 16 characters');
  const { perMinute = 60, failuresPerMinute = 5, maxConnections = 8 } = limits;
  const hosts = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map((h) => h.toLowerCase())]);
  let hits = [];
  let fails = [];
  const recent = (list) => list.filter((t) => now() - t < 60000);

  const server = http.createServer(async (req, res) => {
    try {
      hits = recent(hits);
      fails = recent(fails);
      if (fails.length >= failuresPerMinute) return send(res, 429, { error: 'too many bad tokens, wait a minute' });
      if (hits.length >= perMinute) return send(res, 429, { error: 'rate limit' });
      hits.push(now());

      const hostName = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      if (!hostName || !hosts.has(hostName)) return send(res, 403, { error: 'host not allowed' });
      // Browsers always send Sec-Fetch-Site; scripts and MCP clients do not.
      if (req.headers.origin || req.headers['sec-fetch-site']) {
        return send(res, 403, { error: 'browser requests are not accepted' });
      }
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      if (!tokenOk(req.headers.authorization, token)) {
        fails.push(now());
        return send(res, 401, { error: 'bad token' });
      }
      const body = parseBody(await readBody(req), req.headers['content-type'] || '');

      if (req.url === '/signal') {
        const out = await escalator.ingest(body);
        return send(res, 200, { id: out.id, tier: out.tier, reasons: out.reasons });
      }
      if (req.url === '/sms') {
        const event = guard.inspectMessage({ from: body.From || body.from, body: body.Body || body.body });
        if (!event) return send(res, 200, { alert: false });
        const out = await escalator.ingest(event);
        return send(res, 200, { alert: true, tier: out.tier });
      }
      if (req.url === '/mcp') {
        const sessionId = req.headers['mcp-session-id'] || crypto.randomUUID();
        const out = await mcp.handle(body);
        res.setHeader('Mcp-Session-Id', sessionId);
        if (out === null) {
          res.writeHead(202);
          return res.end();
        }
        return send(res, 200, out);
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      logger(`request failed: ${err.message}`);
      return send(res, err.status || 500, { error: err.status ? err.message : 'internal error' });
    }
  });
  server.maxConnections = maxConnections;
  server.requestTimeout = 15000;
  return server;
}
