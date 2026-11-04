// The coaching engine: turns an inbound message (from any channel) into reply
// bubbles, keeps per-person memory, and sends the morning check-ins.
import { COACH_PROMPT, COACH_PROMPT_LITE, CHECKIN_REQUEST } from './prompts.js';
import { parseReply, stripContextEcho } from './format.js';
import { newUser } from './users.js';
import { KNOWLEDGE } from './knowledge.js';
import { IMPORT_PROMPT, cleanFacts, fetchPage as fetchPublicPage, htmlToText, readableText } from './import.js';

const MAX_IMPORTS_PER_DAY = 20;
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

export function contextLine(user, now = new Date(), { postingTo = [], offline = false } = {}) {
  const t = localParts(user.timezone, now);
  const day = challengeDay(user, now);
  const parts = [
    `channel: ${user.channel}`,
    `their local time: ${t.label} (${t.timezone})`,
    day ? (day <= 30 ? `challenge: day ${day} of 30` : `challenge: past day 30, now day ${day} and still going`) : 'challenge: not started',
    user.notes.length ? `remembered: ${user.notes.join(' | ')}` : 'remembered: nothing yet',
  ];
  if (postingTo.length) parts.push(`app can publish to: ${postingTo.join(', ')}`);
  if (offline) parts.push('app is offline: no web search right now; draft posts as normal, the app holds them and publishes once it is back online');
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

const HELP = `Commands: "timezone Europe/London" sets your clock for check-ins · "pause" stops morning check-ins · "resume" turns them back on · "restart challenge" starts a new 30 days · "reset" forgets this conversation · "notes" lists what I remember about you · "forget 3" removes one note · "import https://…" reads a website into my notes.`;

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
  if (lower === 'notes') return user.notes.length ? `What I remember:\n${user.notes.map((n, i) => `${i + 1}. ${n}`).join('\n')}\nSay "forget 2" to remove one.` : "I don't remember anything about you yet.";
  const forget = lower.match(/^forget\s+(\d{1,3})$/);
  if (forget) {
    const i = Number(forget[1]) - 1;
    if (!user.notes[i]) return `There's no note ${forget[1]}. Say "notes" to see them.`;
    const [gone] = user.notes.splice(i, 1);
    return `Forgot: ${gone}`;
  }
  return null;
}

export function createCoach({ llm, users, webSearch = true, channels = {}, publisher = null, connectivity = null, fetchPage = fetchPublicPage, maxTurnsPerDay = 150, log = console, now = () => new Date() }) {
  const queues = new Map();

  async function loadUser(key) {
    const user = await users.get(key);
    if (user) user.pendingPosts ??= [];
    return user;
  }

  /** Model call + reply parsing shared by inbound turns and check-ins. */
  async function coachTurn(user, turnText, t, search) {
    const postingTo = publisher?.platformsFor(user) ?? [];
    const raw = await llm.complete({
      system: SYSTEM,
      systemLite: COACH_PROMPT_LITE,
      webSearch: search,
      messages: buildMessages(user, turnText, t, { postingTo, offline: Boolean(connectivity?.offline) }),
    });
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
   * Turns imported material (an intro from another AI, a pasted note, a file's text, or a website) into notes.
   * The model only ever reads it as data; the facts it returns are cleaned, shown back with numbers, and can be
   * removed with "forget N".
   */
  async function doImport(user, { source = 'paste', label = '', text = '', url = '' }, t) {
    const today = localParts(user.timezone, t).date;
    const day = user.importDay?.date === today ? user.importDay : { date: today, count: 0 };
    if (day.count >= MAX_IMPORTS_PER_DAY) return [{ type: 'text', text: "That's plenty of imports for one day. Let's work with what I have, and bring more tomorrow." }];

    let material = text;
    let from = label || (source === 'file' ? 'that file' : source === 'url' ? url : 'what you pasted');
    if (source === 'url') {
      try {
        const page = await fetchPage(url);
        material = /html/i.test(page.type) ? htmlToText(page.text) : page.text;
        from = label || page.url;
      } catch (err) {
        const safe = ['EBLOCKED', 'EHTTP', 'ETIMEDOUT'].includes(err.code) ? ` ${err.message}` : '';
        return [{ type: 'text', text: `I couldn't read that address.${safe} Check it, or paste the text here instead.` }];
      }
    }
    const clean = readableText(material);
    if (clean.length < 20) return [{ type: 'text', text: "There wasn't enough text in that to import. Paste the content here instead." }];
    from = from.slice(0, 80);

    day.count += 1;
    user.importDay = day;
    const raw = await llm.complete({
      system: IMPORT_PROMPT,
      systemLite: IMPORT_PROMPT,
      webSearch: false,
      messages: [{ role: 'user', content: `Material from ${from}:\n<<<\n${clean}\n>>>` }],
    });
    const fresh = cleanFacts(parseReply(raw).memories).filter((f) => !user.notes.includes(f));
    remember(user, fresh);
    const saved = fresh.map((f) => [user.notes.indexOf(f) + 1, f]).filter(([n]) => n > 0);
    const bubbles = saved.length
      ? [
        { type: 'text', text: `Imported from ${from}. I saved ${saved.length} thing${saved.length === 1 ? '' : 's'}:` },
        { type: 'text', text: saved.map(([n, f]) => `${n}. ${f}`).join('\n') },
        { type: 'text', text: 'Anything wrong or private? Say "forget 2" to remove one, or "notes" to see everything. Tell me what is missing and I will skip the questions I already have answers to.' },
      ]
      : [{ type: 'text', text: `I read ${from} but found nothing new I could use. If it is an intro from another AI, paste the intro text itself.` }];
    const at = t.toISOString();
    user.messages.push({ role: 'user', content: `(imported ${from})`, at }, { role: 'assistant', content: bubbles.map((b) => b.text).join('\n\n'), at: now().toISOString() });
    return bubbles;
  }

  /** The web chat's Import dialog: paste, file text or a web address. */
  function importContext({ key, source, label, text, url }) {
    return serialize(key, async () => {
      const t = now();
      const user = (await loadUser(key)) ?? newUser(key, 'web', key.replace(/^web:/, ''));
      const bubbles = await doImport(user, { source, label, text, url }, t);
      await users.save(user);
      return bubbles;
    });
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
      const importUrl = bubbles || commandReply ? null : body.match(/^import\s+(https?:\/\/\S+)$/i)?.[1];
      const today = localParts(user.timezone, t).date;
      const turnsToday = user.messages.filter((m) => m.role === 'user' && m.at?.startsWith(today)).length;

      if (bubbles) {
        // A "post it" reply from the publisher.
      } else if (commandReply) {
        bubbles = [{ type: 'text', text: commandReply }];
      } else if (importUrl) {
        bubbles = await doImport(user, { source: 'url', url: importUrl }, t);
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

  return { handleInbound, checkin, runCheckins, publishDraft, importContext };
}
