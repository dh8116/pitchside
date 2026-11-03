// The coaching engine: turns an inbound message (from any channel) into reply
// bubbles, keeps per-person memory, and sends the morning check-ins.
import { COACH_PROMPT, CHECKIN_REQUEST } from './prompts.js';
import { parseReply, stripContextEcho } from './format.js';
import { newUser } from './users.js';
import { KNOWLEDGE } from './knowledge.js';

const SYSTEM = `${COACH_PROMPT}\n\n${KNOWLEDGE}`;
const MAX_HISTORY = 80;
const MAX_NOTES = 40;
const MAX_INBOUND_CHARS = 6000;
const DAY_MS = 86_400_000;

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

export function contextLine(user, now = new Date(), { postingTo = [] } = {}) {
  const t = localParts(user.timezone, now);
  const day = challengeDay(user, now);
  const parts = [
    `channel: ${user.channel}`,
    `their local time: ${t.label} (${t.timezone})`,
    day ? (day <= 30 ? `challenge: day ${day} of 30` : `challenge: finished (day ${day})`) : 'challenge: not started',
    user.notes.length ? `remembered: ${user.notes.join(' | ')}` : 'remembered: nothing yet',
  ];
  if (postingTo.length) parts.push(`app can publish to: ${postingTo.join(', ')}`);
  return `[Pitchside context · ${parts.join(' · ')}]`;
}

/** Builds the API message list: stored history + the new turn with context attached. */
export function buildMessages(user, turnText, now = new Date(), opts) {
  // Echoed context lines in old replies would teach the model to keep echoing.
  const history = user.messages.slice(-MAX_HISTORY)
    .map(({ role, content }) => ({ role, content: role === 'assistant' ? stripContextEcho(content) : content }));
  while (history.length && history[0].role !== 'user') history.shift();
  return [...history, { role: 'user', content: `${contextLine(user, now, opts)}\n${turnText}` }];
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

export function createCoach({ llm, users, webSearch = true, channels = {}, publisher = null, maxTurnsPerDay = 150, log = console, now = () => new Date() }) {
  const queues = new Map();

  async function loadUser(key) {
    const user = await users.get(key);
    if (user) user.pendingPosts ??= [];
    return user;
  }

  /** Model call + reply parsing shared by inbound turns and check-ins. */
  async function coachTurn(user, turnText, t, search) {
    const postingTo = publisher?.platformsFor(user) ?? [];
    const raw = await llm.complete({ system: SYSTEM, webSearch: search, messages: buildMessages(user, turnText, t, { postingTo }) });
    const parsed = parseReply(raw);
    remember(user, parsed.memories);
    const bubbles = publisher ? await publisher.afterReply(user, parsed.bubbles) : parsed.bubbles;
    // Anything the app added (post prompts, auto-post results) goes into history too.
    const added = bubbles.slice(parsed.bubbles.length).map((b) => b.text);
    user.messages.push(
      { role: 'user', content: turnText, at: t.toISOString() },
      { role: 'assistant', content: added.length ? `${raw}\n\n${added.join('\n\n')}` : raw, at: now().toISOString() },
    );
    return bubbles;
  }

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
      const user = (await loadUser(key)) ?? newUser(key, channel, address);
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

      let bubbles = publisher ? await publisher.command(user, body) : null;
      const commandReply = bubbles ? null : handleCommand(user, body, t);
      const today = localParts(user.timezone, t).date;
      const turnsToday = user.messages.filter((m) => m.role === 'user' && m.at?.startsWith(today)).length;

      if (bubbles) {
        // A "post it" reply from the publisher.
      } else if (commandReply) {
        bubbles = [{ type: 'text', text: commandReply }];
      } else if (turnsToday >= maxTurnsPerDay) {
        bubbles = [{ type: 'text', text: "That's a lot for one day. Go do the work and tell me how it went tomorrow." }];
      } else {
        user.challengeStartedAt ??= t.toISOString();
        bubbles = await coachTurn(user, body, t, webSearch);
      }
      await users.save(user);
      if (shouldDeliver) await deliver(user, bubbles);
      return bubbles;
    });
  }

  /** Sends the morning check-in to one person if it's due. Returns true if sent. */
  function checkin(key, { hour = 8 } = {}) {
    return serialize(key, async () => {
      const user = await loadUser(key);
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
      const bubbles = await coachTurn(user, CHECKIN_REQUEST, t, false);
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

  /** The web chat's "Post now" button: publish one held draft. */
  function publishDraft({ key, postId }) {
    return serialize(key, async () => {
      const user = await loadUser(key);
      if (!user || !publisher) return [{ type: 'text', text: 'Posting is not set up on this server.' }];
      const bubbles = await publisher.publish(user, postId);
      await users.save(user);
      return bubbles;
    });
  }

  return { handleInbound, checkin, runCheckins, publishDraft };
}
