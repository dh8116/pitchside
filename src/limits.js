// When a model provider says "slow down": how long to wait (read from the provider's own answer) and where to
// go next: add another key on the setup page, or top up the plan.
import { formatWait } from '../public/wait.js';

export const DEFAULT_SETUP_URL = 'https://dh8116.github.io/pitchside/setup/';

export const PROVIDERS = {
  gemini: { label: 'Gemini', topUp: 'https://aistudio.google.com/app/plan_information' },
  groq: { label: 'Groq', topUp: 'https://console.groq.com/settings/billing' },
  meta: { label: 'Meta', topUp: 'https://dev.meta.ai/docs' },
  claude: { label: 'Claude', topUp: 'https://console.anthropic.com/settings/billing' },
};

/** Whole seconds to wait, from a Retry-After header or the provider's message ("try again in 6m32.1s"), or null if it never said. */
export function retryAfterSeconds(err) {
  if (Number.isFinite(err?.retryAfterSec)) return Math.max(1, Math.ceil(err.retryAfterSec));
  const h = err?.headers;
  const header = typeof h?.get === 'function' ? h.get('retry-after') : h?.['retry-after'];
  if (header != null && header !== '') {
    const n = Number(header);
    if (Number.isFinite(n)) return Math.max(1, Math.ceil(n));
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  }
  const msg = String(err?.message ?? '');
  // Groq: "Please try again in 6m32.1s", "in 2h3m4.5s", "in 450ms".
  const groq = msg.match(/try again in\s+(?:(\d+)h)?\s*(?:(\d+)m(?!s))?\s*(?:([\d.]+)s)?\s*(?:([\d.]+)ms)?/i);
  if (groq && (groq[1] || groq[2] || groq[3] || groq[4])) {
    return Math.max(1, Math.ceil((+groq[1] || 0) * 3600 + (+groq[2] || 0) * 60 + (+groq[3] || 0) + (+groq[4] || 0) / 1000));
  }
  // Gemini: "Please retry in 34.2s" or "retryDelay": "34s".
  const gemini = msg.match(/retry in ([\d.]+)s/i) ?? msg.match(/"retryDelay"\s*:\s*"([\d.]+)s"/i);
  if (gemini) return Math.max(1, Math.ceil(Number(gemini[1])));
  return null;
}

/**
 * Everything the chat needs to explain a rate limit: who is limited, exactly how long to wait, and the buttons.
 * Returns null when the error is not a rate limit. `err.limits` (set by the provider chain) lists every provider
 * that was limited; the wait shown is the shortest, because that is when the first one answers again.
 */
export function rateLimitInfo(err, { setupUrl = DEFAULT_SETUP_URL } = {}) {
  const limits = err?.limits?.length ? err.limits : err?.status === 429 ? [{ provider: err.provider, seconds: retryAfterSeconds(err) }] : null;
  if (!limits) return null;
  const known = [...new Set(limits.map((l) => l.provider).filter((p) => PROVIDERS[p]))];
  const waits = limits.map((l) => l.seconds).filter(Number.isFinite);
  const seconds = waits.length ? Math.min(...waits) : null;
  const names = known.length ? known.map((p) => PROVIDERS[p].label) : ['The model API'];
  const who = names.join(' and ');
  const are = names.length > 1 ? 'are' : 'is';
  return {
    seconds,
    wait: seconds == null ? null : formatWait(seconds),
    names: who,
    message: seconds == null ? `${who} ${are} rate limited, and didn't say for how long.` : `${who} ${are} rate limited. Try again in ${formatWait(seconds)}.`,
    setupUrl,
    topUp: known.map((p) => ({ provider: p, name: PROVIDERS[p].label, url: PROVIDERS[p].topUp })),
  };
}

/** The same thing as one plain message, for channels with no buttons (SMS, WhatsApp, email). */
export function rateLimitText(info) {
  const links = [`add another key: ${info.setupUrl}`, ...info.topUp.map((t) => `top up ${t.name}: ${t.url}`)];
  return `${info.message} You can ${links.join(' · ')}`;
}
