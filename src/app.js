// HTTP routes: channel webhooks, the try-it-in-the-browser chat, static files.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseReply } from './format.js';
import { CHECKIN_REQUEST } from './prompts.js';

const MAX_BODY = 1_000_000;
const UUID_RE = /^[0-9a-f-]{36}$/;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function send(res, status, body, headers = { 'content-type': 'application/json' }) {
  res.writeHead(status, headers);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function friendlyError(err) {
  // Bad keys: 401 on most APIs, 400 "API key not valid" on Gemini, or no status
  // at all when the Anthropic SDK finds no credentials before sending.
  if (err?.status === 401 || /API[_ ]key/i.test(err?.message) || (!err?.status && /authentication method/i.test(err?.message))) return 'The model API key is missing or invalid. Check GEMINI_API_KEY / GROQ_API_KEY / ANTHROPIC_API_KEY in .env.';
  if (err?.status === 429) return 'Rate limited by the API. Give it a minute.';
  return 'Something went wrong on my side. Try again in a moment.';
}

export function createApp({ coach, users, channels, publicDir, webChat = true, log = console }) {
  async function serveStatic(res, pathname) {
    const full = path.resolve(publicDir, pathname === '/' ? 'index.html' : pathname.slice(1));
    if (!full.startsWith(path.resolve(publicDir) + path.sep)) return send(res, 404, { error: 'not found' });
    try {
      const body = await readFile(full);
      send(res, 200, body, { 'content-type': TYPES[path.extname(full)] ?? 'application/octet-stream' });
    } catch {
      send(res, 404, { error: 'not found' });
    }
  }

  return async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (pathname === '/health') return send(res, 200, { ok: true, channels: Object.keys(channels) });

      const hook = pathname.match(/^\/webhooks\/([a-z]+)$/);
      if (hook) {
        const channel = channels[hook[1]];
        if (!channel) return send(res, 404, { error: 'channel not configured' });
        const rawBody = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
        let result;
        try {
          result = channel.webhook({ method: req.method, url, headers: req.headers, rawBody });
        } catch (err) {
          log.error(`bad ${hook[1]} webhook`, err);
          return send(res, 400, { error: 'bad payload' });
        }
        send(res, result.status, result.body, result.headers);
        // Reply asynchronously: the model takes longer than webhook timeouts allow.
        for (const m of result.messages) {
          coach.handleInbound(m).catch((err) => log.error(`reply failed for ${m.key}`, err));
        }
        return;
      }

      if (pathname.startsWith('/api/web/')) {
        if (!webChat) return send(res, 404, { error: 'web chat is disabled' });
        if (req.method === 'POST' && pathname === '/api/web/chat') {
          let body;
          try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
          const { id, text } = body ?? {};
          if (!UUID_RE.test(String(id))) return send(res, 400, { error: 'id must be a UUID' });
          if (typeof text !== 'string' || !text.trim()) return send(res, 400, { error: 'text is required' });
          try {
            const bubbles = await coach.handleInbound({ key: `web:${id}`, channel: 'web', address: id, text, deliver: false });
            return send(res, 200, { bubbles });
          } catch (err) {
            log.error(err);
            return send(res, 502, { error: friendlyError(err) });
          }
        }
        if (req.method === 'GET' && pathname === '/api/web/history') {
          const id = url.searchParams.get('id');
          if (!UUID_RE.test(String(id))) return send(res, 400, { error: 'id must be a UUID' });
          const user = await users.get(`web:${id}`);
          const messages = (user?.messages ?? [])
            .filter((m) => m.content !== CHECKIN_REQUEST)
            .map((m) => (m.role === 'user' ? { role: 'user', text: m.content } : { role: 'assistant', bubbles: parseReply(m.content).bubbles }));
          return send(res, 200, { messages });
        }
        return send(res, 404, { error: 'not found' });
      }

      if (req.method === 'GET') return serveStatic(res, pathname);
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err.status === 413) return send(res, 413, { error: err.message });
      log.error(err);
      return send(res, 500, { error: 'internal error' });
    }
  };
}
