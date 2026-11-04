// HTTP routes: channel webhooks, the try-it-in-the-browser chat, static files.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseReply } from './format.js';
import { CHECKIN_REQUEST } from './prompts.js';
import { safeEqual } from './channels/util.js';
import { isNetworkError } from './connectivity.js';
import { INTRO_PROMPT } from './import.js';

const IMPORT_SOURCES = new Set(['paste', 'file', 'url']);
const MAX_IMPORT_TEXT = 300_000; // characters accepted from the browser; the coach keeps the first part

const MAX_BODY = 1_000_000;
const UUID_RE = /^[0-9a-f-]{36}$/;
const MAX_FAILED_PASSCODES = 10;
const LOCKOUT_MS = 15 * 60_000;
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
  if (err?.status === 401 || /API[_ ]key/i.test(err?.message) || (!err?.status && /authentication method/i.test(err?.message))) return 'The model API key is missing or invalid. Check GEMINI_API_KEY / GROQ_API_KEY / MODEL_API_KEY / ANTHROPIC_API_KEY in .env.';
  if (err?.status === 429) return 'Rate limited by the API. Give it a minute.';
  if (err?.code === 'NO_LOCAL_MODEL' || isNetworkError(err)) return "I can't reach the internet and there's no local model to fall back on. Install Ollama (ollama.com), run `ollama pull qwen2.5:3b`, and I'll use it automatically when offline.";
  return 'Something went wrong on my side. Try again in a moment.';
}

export function createApp({ coach, users, channels, publicDir, webChat = true, webChatPassword = '', connectivity = null, log = console, now = () => Date.now() }) {
  // Wrong-passcode attempts per client address, so the passcode can't be guessed by brute force.
  const failures = new Map();

  function checkPasscode(req) {
    if (!webChatPassword) return null;
    const ip = req.socket.remoteAddress ?? 'unknown';
    const f = failures.get(ip);
    if (f && f.count >= MAX_FAILED_PASSCODES && now() - f.first < LOCKOUT_MS) return { status: 429, error: 'Too many wrong passcodes. Try again in 15 minutes.' };
    if (safeEqual(req.headers['x-pitchside-passcode'], webChatPassword)) { failures.delete(ip); return null; }
    if (req.headers['x-pitchside-passcode'] !== undefined) {
      const fresh = !f || now() - f.first >= LOCKOUT_MS;
      failures.set(ip, fresh ? { count: 1, first: now() } : { ...f, count: f.count + 1 });
    }
    return { status: 401, error: 'passcode required', passcode: true };
  }

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

      const hook = pathname.match(/^\/webhooks\/([a-z]+)(\/[a-z]+)?$/);
      if (hook) {
        const channel = channels[hook[1]];
        if (!channel || (hook[2] && !channel.handle)) return send(res, 404, { error: 'channel not configured' });
        const rawBody = req.method === 'POST' ? await readBody(req) : Buffer.alloc(0);
        // Channels that answer in-line (phone calls) take the coach and reply themselves.
        if (channel.handle) {
          try {
            const result = await channel.handle({ method: req.method, url, headers: req.headers, rawBody, coach });
            return send(res, result.status, result.body, result.headers);
          } catch (err) {
            log.error(`bad ${hook[1]} webhook`, err);
            return send(res, 400, { error: 'bad payload' });
          }
        }
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
        const denied = checkPasscode(req);
        if (denied) return send(res, denied.status, { error: denied.error, passcode: denied.status === 401 });
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
        if (req.method === 'POST' && pathname === '/api/web/post') {
          let body;
          try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
          const { id, postId } = body ?? {};
          if (!UUID_RE.test(String(id))) return send(res, 400, { error: 'id must be a UUID' });
          if (!Number.isInteger(postId)) return send(res, 400, { error: 'postId must be an integer' });
          try {
            return send(res, 200, { bubbles: await coach.publishDraft({ key: `web:${id}`, postId }) });
          } catch (err) {
            log.error(err);
            return send(res, 502, { error: friendlyError(err) });
          }
        }
        // Import dialog: the prompt to paste into ChatGPT / Claude / Gemini, and the import itself.
        if (req.method === 'GET' && pathname === '/api/web/import-prompt') return send(res, 200, { prompt: INTRO_PROMPT });
        if (req.method === 'POST' && pathname === '/api/web/import') {
          let body;
          try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch { return send(res, 400, { error: 'invalid JSON' }); }
          const { id, source, label, text, url } = body ?? {};
          if (!UUID_RE.test(String(id))) return send(res, 400, { error: 'id must be a UUID' });
          if (!IMPORT_SOURCES.has(source)) return send(res, 400, { error: 'source must be paste, file or url' });
          if (source === 'url' ? !/^https?:\/\/\S{3,2000}$/i.test(String(url)) : typeof text !== 'string' || !text.trim()) {
            return send(res, 400, { error: source === 'url' ? 'url must be an http(s) address' : 'text is required' });
          }
          try {
            const bubbles = await coach.importContext({
              key: `web:${id}`, source,
              label: typeof label === 'string' ? label.slice(0, 80) : '',
              text: typeof text === 'string' ? text.slice(0, MAX_IMPORT_TEXT) : '',
              url: typeof url === 'string' ? url : '',
            });
            return send(res, 200, { bubbles });
          } catch (err) {
            log.error(err);
            return send(res, 502, { error: friendlyError(err) });
          }
        }
        // The chat polls this: while offline its Post buttons grey out, and they come back when this says true.
        if (req.method === 'GET' && pathname === '/api/web/status') {
          return send(res, 200, { online: connectivity ? await connectivity.check() : true });
        }
        if (req.method === 'GET' && pathname === '/api/web/history') {
          const id = url.searchParams.get('id');
          if (!UUID_RE.test(String(id))) return send(res, 400, { error: 'id must be a UUID' });
          const user = await users.get(`web:${id}`);
          const pending = user?.pendingPosts ?? [];
          // Drafts still waiting keep their "Post now" button after a reload.
          const withPostIds = (b) => {
            const draft = b.type === 'post' && pending.find((p) => p.platform === b.platform && p.text === b.text);
            return draft ? { ...b, postId: draft.id } : b;
          };
          const messages = (user?.messages ?? [])
            .filter((m) => m.content !== CHECKIN_REQUEST)
            .map((m) => (m.role === 'user' ? { role: 'user', text: m.content } : { role: 'assistant', bubbles: parseReply(m.content).bubbles.map(withPostIds) }));
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
