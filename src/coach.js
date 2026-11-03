// The coaching engine: turns an inbound message (from any channel) into reply
// bubbles, keeps per-person memory, and sends the morning check-ins.
import { COACH_PROMPT, CHECKIN_REQUEST } from './prompts.js';
import { parseReply } from './format.js';
import { newUser } from './users.js';

export const DEFAULT_MODEL = 'claude-opus-5';
const MAX_HISTORY = 80;
const MAX_NOTES = 40;
const MAX_INBOUND_CHARS = 6000;
const MAX_PAUSE_CONTINUATIONS = 3;
const DAY_MS = 86_400_000;

// Server-side refusal fallback: if the main model declines, the API reruns
// the request on a fallback model it picks, inside the same call.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
}

export function localParts(timezone, now = new Date()) {
  const tz = validTimezone(timezone) ? timezone : 'UTC';
  const fmt = (opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(now);
  return {
    date: new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now), // YYYY-MM-DD
    hour: Number(fmt({ hour: '2-digit', hourCycle: 'h23' })),
    label: fmt({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }),
    timezone: tz,
  };
}

export function challengeDay(user, now = new Date()) {
  if (!user.challengeStartedAt) return null;
  const start = localParts(user.timezone, new Date(user.challengeStartedAt)).date;
  const today = localParts(user.timezone, now).date;
  return Math.floor((Date.parse(today) - Date.parse(start)) / DAY_MS) + 1;
}

export function contextLine(user, now = new Date()) {
  const t = localParts(user.timezone, now);
  const day = challengeDay(user, now);
  const parts = [
    `channel: ${user.channel}`,
    `their local time: ${t.label} (${t.timezone})`,
    day ? (day <= 30 ? `challenge: day ${day} of 30` : `challenge: finished (day ${day})`) : 'challenge: not started',
    user.notes.length ? `remembered: ${user.notes.join(' | ')}` : 'remembered: nothing yet',
  ];
  return `[Pitchside context · ${parts.join(' · ')}]`;
}

/** Builds the API message list: stored history + the new turn with context attached. */
export function buildMessages(user, turnText, now = new Date()) {
  const history = user.messages.slice(-MAX_HISTORY).map(({ role, content }) => ({ role, content }));
  while (history.length && history[0].role !== 'user') history.shift();
  return [...history, { role: 'user', content: `${contextLine(user, now)}\n${turnText}` }];
}

async function callModel(client, { model, messages, webSearch, signal }) {
  const tools = webSearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }] : undefined;
  const convo = [...messages];
  let text = '';
  for (let i = 0; i <= MAX_PAUSE_CONTINUATIONS; i++) {
    const msg = await client.beta.messages.stream({
      ...FALLBACK,
      model,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: COACH_PROMPT,
      tools,
      messages: convo,
    }, { signal }).finalMessage();

    for (const block of msg.content) if (block.type === 'text') text += block.text;
    if (msg.stop_reason === 'refusal') return `${text}\n\nI can't help with that one. Try me on a different angle.`;
    // A long web-search turn can pause; hand it back as-is so it can finish.
    if (msg.stop_reason !== 'pause_turn') break;
    convo.push({ role: 'assistant', content: msg.content });
  }
  return text;
}

const HELP = `Commands: "timezone Europe/London" sets your clock for check-ins · "pause" stops morning check-ins · "resume" turns them back on · "restart challenge" starts a new 30 days · "reset" forgets this conversation.`;

function handleCommand(user, text, now) {
  const t = text.trim();
  const lower = t.toLowerCase();
  const tz = t.match(/^time\s*zone\s+(\S+)$/i);
  if (tz) {
    if (!validTimezone(tz[1])) return `I don't know the timezone "${tz[1]}". Use a name like America/New_York or Asia/Singapore.`;
    user.timezone = tz[1];
    return `Got it, your clock is ${localParts(tz[1], now).label} (${tz[1]}).`;
  }
  if (lower === 'pause') { user.checkins = false; return 'Morning check-ins paused. Text "resume" when you want them back.'; }
  if (lower === 'resume') { user.checkins = true; return 'Check-ins are back on. See you in the morning.'; }
  if (lower === 'restart challenge') { user.challengeStartedAt = now.toISOString(); return 'New 30 days starts today. Day 1: tell me the one result you want by day 30.'; }
  if (lower === 'reset') { user.messages = []; user.notes = []; user.challengeStartedAt = null; return 'Clean slate. What are you working on?'; }
  if (lower === 'help' || lower === 'commands') return HELP;
  return null;
}

export function createCoach({ client, users, model = DEFAULT_MODEL, webSearch = true, channels = {}, maxTurnsPerDay = 150, log = console, now = () => new Date() }) {
  const queues = new Map();

  // One message at a time per person, so replies never interleave.
  function serialize(key, fn) {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    queues.set(key, next);
    next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  }

  async function deliver(user, bubbles) {
    const channel = channels[user.channel];
    if (channel?.send) await channel.send(user, bubbles);
  }

  function remember(user, memories) {
    for (const m of memories) if (!user.notes.includes(m)) user.notes.push(m);
    user.notes = user.notes.slice(-MAX_NOTES);
  }

  /**
   * Handle one inbound message. Returns the reply bubbles (also delivered
   * through the person's channel unless deliver === false).
   */
  function handleInbound({ key, channel, address, messageId, text, meta, deliver: shouldDeliver = true }) {
    return serialize(key, async () => {
      const t = now();
      const user = (await users.get(key)) ?? newUser(key, channel, address);
      user.channel = channel;
      user.address = address;
      if (meta) user.meta = { ...user.meta, ...meta };
      if (messageId) {
        if (user.seenIds.includes(messageId)) return [];
        user.seenIds.push(messageId);
      }
      user.lastInboundAt = t.toISOString();
      const body = String(text ?? '').trim().slice(0, MAX_INBOUND_CHARS);
      if (!body) { await users.save(user); return []; }

      let bubbles;
      const commandReply = handleCommand(user, body, t);
      const today = localParts(user.timezone, t).date;
      const turnsToday = user.messages.filter((m) => m.role === 'user' && m.at?.startsWith(today)).length;

      if (commandReply) {
        bubbles = [{ type: 'text', text: commandReply }];
      } else if (turnsToday >= maxTurnsPerDay) {
        bubbles = [{ type: 'text', text: "That's a lot for one day. Go do the work and tell me how it went tomorrow." }];
      } else {
        user.challengeStartedAt ??= t.toISOString();
        const raw = await callModel(client, { model, webSearch, messages: buildMessages(user, body, t) });
        const parsed = parseReply(raw);
        remember(user, parsed.memories);
        bubbles = parsed.bubbles;
        user.messages.push({ role: 'user', content: body, at: t.toISOString() }, { role: 'assistant', content: raw, at: now().toISOString() });
      }
      await users.save(user);
      if (shouldDeliver) await deliver(user, bubbles);
      return bubbles;
    });
  }

  /** Sends the morning check-in to one person if it's due. Returns true if sent. */
  function checkin(key, { hour = 8 } = {}) {
    return serialize(key, async () => {
      const user = await users.get(key);
      const t = now();
      if (!user || !user.checkins || !user.challengeStartedAt || !channels[user.channel]?.send) return false;
      const local = localParts(user.timezone, t);
      if (local.hour !== hour || user.lastCheckinDate === local.date) return false;
      const day = challengeDay(user, t);
      if (day > 31) return false;
      // WhatsApp only allows free-form business messages within 24h of the
      // person's last message; outside it you'd need an approved template.
      if (user.channel === 'whatsapp' || user.address?.startsWith?.('whatsapp:')) {
        if (!user.lastInboundAt || t - new Date(user.lastInboundAt) > 23 * 3_600_000) return false;
      }
      const raw = await callModel(client, { model, webSearch: false, messages: buildMessages(user, CHECKIN_REQUEST, t) });
      const { bubbles, memories } = parseReply(raw);
      remember(user, memories);
      user.messages.push({ role: 'user', content: CHECKIN_REQUEST, at: t.toISOString() }, { role: 'assistant', content: raw, at: now().toISOString() });
      user.lastCheckinDate = local.date;
      await users.save(user);
      await deliver(user, bubbles);
      return true;
    });
  }

  async function runCheckins(opts) {
    let sent = 0;
    for await (const user of users.all()) {
      try { if (await checkin(user.key, opts)) sent++; } catch (err) { log.error('check-in failed', user.key, err); }
    }
    return sent;
  }

  return { handleInbound, checkin, runCheckins };
}
