// Turns the coach's raw reply into chat bubbles, and bubbles into channel text.

const POST_RE = /<post(?:\s+platform="([a-z]+)")?\s*>([\s\S]*?)<\/post>/gi;
const REMEMBER_RE = /<remember>([\s\S]*?)<\/remember>/gi;
// Weaker models sometimes echo the app's per-turn context line back; never show it.
const CONTEXT_ECHO_RE = /^[ \t]*\[Pitchside context\b[^\n]*(?:\n|$)/gim;

const SHARE_URLS = {
  x: (t) => `https://x.com/intent/post?text=${encodeURIComponent(t)}`,
  linkedin: (t) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(t)}`,
  threads: (t) => `https://www.threads.net/intent/post?text=${encodeURIComponent(t)}`,
  bluesky: (t) => `https://bsky.app/intent/compose?text=${encodeURIComponent(t)}`,
};

/** Removes any echoed "[Pitchside context …]" line from model output. */
export const stripContextEcho = (text) => text.replace(CONTEXT_ECHO_RE, '');

export function shareLink(platform, text) {
  return (SHARE_URLS[platform] ?? SHARE_URLS.x)(text);
}

const LIMITS = { x: 280, bluesky: 300, threads: 500, linkedin: 3000 };
const graphemes = (s) => [...new Intl.Segmenter().segment(s)];

/** Models ignore "no markdown" now and then: strips code fences, **bold**, # headings and turns [text](url) into "text (url)". */
export function plainText(text) {
  return String(text)
    .replace(/^[ \t]*```.*\n?/gm, '')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, '$1$2')
    .replace(/^[ \t]*\*[ \t]+/gm, '- ')
    .replace(/(^|[\s(])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/(^|[\s(])_(?![\s_])([^_\n]+?)(?<![\s_])_(?=[\s).,!?:;]|$)/g, '$1$2')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '$1 ($2)')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Smaller local models often write the draft but forget the <post> tag. A multi-line bubble that ends with
// the challenge signature line is a draft all the same, so it becomes a post card (the platform is the first
// one the reply names, else X). The signature line on its own, anywhere else in the reply, is an artefact and goes.
const SIGNATURE_RE = /^day\s+\d+(?:\s+of\s+30)?\s+with\s+pitchside[.!]?$/i;
const PLATFORM_WORD_RE = /\b(bluesky|linkedin|threads)\b/i;

/**
 * Makes a drafted post publishable on its platform: markdown out, one thought per line, the Day N signature once
 * and last, and trimmed to the platform's limit by dropping the closing lines (never the first) before cutting words.
 */
export function normalizePost(text, platform = 'x') {
  const lines = plainText(text).split('\n').map((l) => l.trim());
  const sig = lines.filter((l) => SIGNATURE_RE.test(l)).at(-1);
  // Paragraph breaks stay (LinkedIn wants them); doubled and edge blank lines go.
  const tidy = (arr) => arr.filter((l, i) => l || (i > 0 && arr[i - 1] && arr.slice(i + 1).some(Boolean)));
  let body = tidy(lines.filter((l) => !SIGNATURE_RE.test(l)));
  const limit = LIMITS[platform] ?? LIMITS.x;
  const join = () => [...body, ...(sig ? [sig] : [])].join('\n');
  while (graphemes(join()).length > limit && body.filter(Boolean).length > 1) body = tidy(body.slice(0, -1));
  let out = join();
  if (graphemes(out).length > limit) {
    const room = Math.max(limit - (sig ? graphemes(sig).length + 1 : 0) - 1, 0);
    const cut = graphemes(body[0] ?? '').slice(0, room).map((g) => g.segment).join('').trimEnd();
    out = [`${cut}\u2026`, ...(sig ? [sig] : [])].join('\n');
  }
  return out;
}

/**
 * @returns {{ bubbles: Array<{type:'text', text:string} | {type:'post', platform:string, text:string, link:string}>, memories: string[] }}
 */
export function parseReply(raw) {
  const memories = [...raw.matchAll(REMEMBER_RE)].map((m) => m[1].trim()).filter(Boolean);
  const text = stripContextEcho(raw.replace(REMEMBER_RE, ''));

  const bubbles = [];
  const pushText = (chunk) => {
    for (const para of plainText(chunk).split(/\n\s*\n/)) {
      const t = para.trim();
      if (t) bubbles.push({ type: 'text', text: t });
    }
  };
  const post = (platform, body) => {
    const clean = normalizePost(body, platform);
    return { type: 'post', platform, text: clean, link: shareLink(platform, clean) };
  };

  let last = 0;
  for (const m of text.matchAll(POST_RE)) {
    pushText(text.slice(last, m.index));
    const platform = (m[1] || 'x').toLowerCase();
    if (m[2].trim()) bubbles.push(post(platform, m[2]));
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));

  if (!bubbles.some((b) => b.type === 'post')) {
    const at = bubbles.findIndex((b) => {
      const lines = b.text.split('\n').map((l) => l.trim()).filter(Boolean);
      return lines.length >= 2 && SIGNATURE_RE.test(lines.at(-1));
    });
    if (at >= 0) bubbles[at] = post((text.match(PLATFORM_WORD_RE)?.[1] ?? 'x').toLowerCase(), bubbles[at].text);
  }
  const hasPost = bubbles.some((b) => b.type === 'post');
  return { bubbles: hasPost ? bubbles.filter((b) => !(b.type === 'text' && SIGNATURE_RE.test(b.text.trim()))) : bubbles, memories };
}


// ---- Keeping replies short and direct ----

// "Sure, …", "Great! …", "Got it. …" and "That's a question about X, which matters." say nothing; the answer is what counts.
const FILLER_RE = /^(?:(?:sure|certainly|absolutely|of course|great|awesome|nice|perfect|got it|okay|ok|alright|understood|well|right|so|good question|great question)(?:\s+(?:thing|then))?[,!.:\u2013\u2014-]+\s*)+/i;
const META_RE = /^that'?s (?:an?|the) [^.?!]{0,80}\b(?:question|point|concern|decision|topic)\b[^.?!]{0,80}[.?!]\s+/i;

/** Drops filler from the start of the first text bubble (and the bubble itself if nothing is left). */
export function stripLeadIn(bubbles) {
  const at = bubbles.findIndex((b) => b.type === 'text');
  if (at < 0) return bubbles;
  const cleaned = bubbles[at].text.replace(META_RE, '').replace(FILLER_RE, '').trim();
  const text = cleaned && cleaned[0].toUpperCase() + cleaned.slice(1);
  return text ? bubbles.map((b, i) => (i === at ? { ...b, text } : b)) : bubbles.filter((_, i) => i !== at);
}

/** True when the person deliberately asked for length: detail, a plan, an explanation, a full draft… */
export const wantsLong = (text) => /\b(?:in detail|detailed|in[- ]depth|thorough(?:ly)?|step[- ]by[- ]step|walk me through|explain|elaborate|full (?:plan|draft|list|breakdown)|complete (?:plan|list)|30[- ]day|playbook|roadmap|outline|essay|longer|everything|plan my|write (?:me )?(?:a|the) (?:plan|doc|email|script|article))\b/i.test(String(text));

function cutAtSentence(text, room) {
  const head = text.slice(0, room);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  if (end >= 40) return head.slice(0, end + 1);
  const space = head.lastIndexOf(' ');
  return `${head.slice(0, space > 20 ? space : room).replace(/[,;:\s]+$/, '')}\u2026`;
}

/**
 * Keeps a reply from becoming a page: at most 4 bubbles and about 700 characters (8 and 2400 when the person asked
 * for detail; a research brief gets 1100). Post drafts are never cut here. A closing question always survives.
 */
export function capReply(bubbles, { long = false } = {}) {
  const brief = bubbles.some((b) => b.type === 'text' && /^verdict:/i.test(b.text));
  const maxBubbles = long ? 8 : 4;
  const maxChars = long ? 2400 : brief ? 1100 : 700;
  const texts = bubbles.filter((b) => b.type === 'text');
  const kept = new Set();
  let used = 0;
  let count = 0;
  const out = [];
  for (const b of bubbles) {
    if (b.type !== 'text') { out.push(b); continue; }
    const room = maxChars - used;
    if (count >= maxBubbles || (count > 0 && room < 40)) continue;
    const text = b.text.length > room ? cutAtSentence(b.text, room) : b.text;
    out.push({ ...b, text });
    kept.add(b);
    used += text.length;
    count += 1;
  }
  const last = texts.at(-1);
  if (last && !kept.has(last) && /\?\s*$/.test(last.text) && last.text.length <= 160) out.push(last);
  return out;
}

/** A reply's bubbles back as the raw text the model would have written (what goes into history). */
export const bubblesToRaw = (bubbles) => bubbles.map((b) => (b.type === 'post' ? `<post platform="${b.platform}">${b.text}</post>` : b.text)).join('\n\n');

const PLATFORM_NAMES = { x: 'X', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky' };

/** Plain-text rendering of one bubble, for SMS/WhatsApp/iMessage. */
export function bubbleToText(b) {
  if (b.type === 'post') return `${b.text}\n\ntap to post it on ${PLATFORM_NAMES[b.platform] ?? b.platform}: ${b.link}`;
  return b.text;
}

/** All bubbles in one plain-text body, for email. */
export function bubblesToEmail(bubbles) {
  return bubbles.map((b) => (b.type === 'post'
    ? `---\n${b.text}\n---\nPost it on ${PLATFORM_NAMES[b.platform] ?? b.platform}: ${b.link}`
    : b.text)).join('\n\n');
}
