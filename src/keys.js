// API keys, and the mistakes people make with them. Cleans what a paste leaves behind, says which key the app
// really loaded (only the last four characters, never the key), notices a shell variable silently beating .env,
// and asks the provider whether it accepts the key.
import { retryAfterSeconds } from './limits.js';
import { formatWait } from '../public/wait.js';

/** What a paste leaves around a key: spaces, a line break, quotes, "Bearer ", or the NAME= it was copied with. */
export function cleanKey(value) {
  const fixes = [];
  let key = String(value ?? '');
  const trimmed = key.replace(/^﻿/, '').trim();
  if (trimmed !== key) fixes.push('removed spaces or a line break around it');
  key = trimmed;
  const named = key.match(/^[A-Za-z][A-Za-z0-9_]*=([\s\S]*)$/);
  if (named) { key = named[1].trim(); fixes.push('removed the NAME= that was pasted with it'); }
  const quoted = key.match(/^(["'`“‘])([\s\S]*)(["'`”’])$/);
  if (quoted) { key = quoted[2].trim(); fixes.push('removed quote marks'); }
  const bearer = key.match(/^bearer\s+([\s\S]*)$/i);
  if (bearer) { key = bearer[1].trim(); fixes.push('removed "Bearer "'); }
  return { key, fixes };
}

const SHAPES = {
  groq: { re: /^gsk_[A-Za-z0-9]{20,}$/, hint: 'Groq keys start with gsk_' },
  gemini: { re: /^AIza[0-9A-Za-z_-]{30,}$/, hint: 'Gemini keys start with AIza' },
  claude: { re: /^sk-ant-[A-Za-z0-9_-]{20,}$/, hint: 'Anthropic keys start with sk-ant-' },
};

/** Why a key can't be right, in plain words, or null if it looks fine. */
export function keyProblem(provider, key) {
  if (!key) return 'it is empty';
  if (/\s/.test(key)) return 'it has a space or line break in the middle (pasted twice, or split over two lines?)';
  // eslint-disable-next-line no-control-regex
  if (/[^!-~]/.test(key)) return 'it has a character that is not plain text, such as a curly quote or an invisible character from copying';
  const shape = SHAPES[provider];
  if (shape && !shape.re.test(key)) return `${shape.hint}, and this one does not look like that`;
  return null;
}

/** The last four characters, enough to tell two keys apart and never enough to use one. */
export const fingerprint = (key) => (key ? `…${String(key).slice(-4)}` : '');

const SECRETISH = /KEY|TOKEN|SECRET|PASSWORD/;

/**
 * Variables that are in the .env file but set to something different in the real environment. The app loads .env
 * without overriding anything already set, so the shell's value silently wins and the new key in .env is ignored.
 */
export function envFileConflicts(fileText, env) {
  const out = [];
  for (const line of String(fileText ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || env[m[1]] === undefined) continue;
    let value = m[2];
    if (!/^["']/.test(value)) value = value.replace(/\s+#.*$/, '');
    const fromFile = cleanKey(value).key;
    const fromEnv = cleanKey(env[m[1]]).key;
    if (fromFile && fromFile !== fromEnv) {
      out.push({ name: m[1], ...(SECRETISH.test(m[1]) ? { fileHint: fingerprint(fromFile), envHint: fingerprint(fromEnv) } : {}) });
    }
  }
  return out;
}

/** Asks a provider whether it accepts this key (a models listing: no tokens used). */
export async function probeKey({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = 8000 }) {
  let res;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { status: 'unreachable' };
  }
  if (res.ok) return { status: 'ok' };
  const body = await res.text().catch(() => '');
  if (res.status === 401 || res.status === 403 || (res.status === 400 && /api[_ ]key/i.test(body))) return { status: 'rejected', code: res.status };
  if (res.status === 429) return { status: 'limited', code: 429, seconds: retryAfterSeconds({ message: body, headers: res.headers }) };
  return { status: 'error', code: res.status };
}

/** One line per key: what was loaded, what was fixed, and whether the provider accepts it. */
export function keyLine({ label, envName, apiKey, fixes = [], problem = null, probe = null }) {
  const bits = [`${label}: ${envName} ${fingerprint(apiKey) || 'is not set'}`];
  if (fixes.length) bits.push(`fixed: ${fixes.join(', ')}`);
  if (problem) bits.push(`looks wrong: ${problem}`);
  if (probe) {
    bits.push({
      ok: 'accepted',
      rejected: 'REJECTED by the provider. Wrong, revoked or from a different account: make a new key',
      limited: `accepted, but rate limited${probe.seconds ? ` for ${formatWait(probe.seconds)}` : ''}`,
      unreachable: 'could not reach the provider to check',
      error: `provider answered ${probe.code}`,
    }[probe.status] ?? probe.status);
  }
  return bits.join(' · ');
}
