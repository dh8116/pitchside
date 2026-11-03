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

/**
 * @returns {{ bubbles: Array<{type:'text', text:string} | {type:'post', platform:string, text:string, link:string}>, memories: string[] }}
 */
export function parseReply(raw) {
  const memories = [...raw.matchAll(REMEMBER_RE)].map((m) => m[1].trim()).filter(Boolean);
  const text = stripContextEcho(raw.replace(REMEMBER_RE, ''));

  const bubbles = [];
  const pushText = (chunk) => {
    for (const para of chunk.split(/\n\s*\n/)) {
      const t = para.trim();
      if (t) bubbles.push({ type: 'text', text: t });
    }
  };

  let last = 0;
  for (const m of text.matchAll(POST_RE)) {
    pushText(text.slice(last, m.index));
    const platform = (m[1] || 'x').toLowerCase();
    const body = m[2].trim();
    if (body) bubbles.push({ type: 'post', platform, text: body, link: shareLink(platform, body) });
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  return { bubbles, memories };
}

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
