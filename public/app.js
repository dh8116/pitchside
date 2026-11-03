const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'pitchside.webId';
const GREETING = "Hey, I'm Pitchside. I help you get what you're building in front of buyers, one day at a time. What are you working on?";
const PLATFORM = { x: 'X', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky' };
const LIMIT = { x: 280, bluesky: 300, threads: 500, linkedin: 3000 };
const CHIPS = [
  "Here's what I'm building…",
  "Draft today's build-in-public post",
  'Who should I cold email first?',
  'Review my landing page copy',
  'Plan my launch week',
];
const STATUS = 'your go-to-market coach';

let busy = false;

function loadId() {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(STORAGE_KEY, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}
let webId = loadId();

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
};

// Plain text with bare URLs turned into links. No HTML from the model is trusted.
function linkify(node, text) {
  const parts = text.split(/(https?:\/\/[^\s)]*[^\s).,!?:;])/g);
  for (const [i, part] of parts.entries()) {
    if (i % 2) node.append(el('a', { href: part, textContent: part, target: '_blank', rel: 'noopener' }));
    else if (part) node.append(part);
  }
  return node;
}

function scrollDown() { $('log').scrollTop = $('log').scrollHeight; }

function setStatus(text) {
  $('status').replaceChildren(el('i', { className: 'dot' }), text);
}

function postCard(bubble) {
  const name = PLATFORM[bubble.platform] ?? bubble.platform;
  const length = [...new Intl.Segmenter().segment(bubble.text)].length;
  const limit = LIMIT[bubble.platform];
  const count = el('span', { className: `count${limit && length > limit ? ' over' : ''}`, textContent: limit ? `${length}/${limit}` : `${length}` });
  const footer = el('footer');
  if (bubble.postId) {
    const btn = el('button', { type: 'button', className: 'btn primary', textContent: `Post now to ${name}` });
    btn.onclick = () => postNow(bubble.postId, btn);
    footer.append(btn);
  }
  footer.append(el('a', {
    className: `btn ${bubble.postId ? 'secondary' : 'primary'}`, href: bubble.link, target: '_blank', rel: 'noopener',
    textContent: `Open in ${name} →`,
  }));
  return el('article', { className: 'card' },
    el('header', {}, `${name} post`, count),
    linkify(el('div', { className: 'body' }), bubble.text),
    footer);
}

function addBubble(side, bubble) {
  const node = bubble.type === 'post'
    ? postCard(bubble)
    : linkify(el('div', { className: `bubble ${side}` }), bubble.text);
  $('log').append(node);
  scrollDown();
  return node;
}

function showTyping() {
  const node = el('div', { className: 'bubble in typing', ariaLabel: 'Pitchside is typing' }, el('i'), el('i'), el('i'));
  $('log').append(node);
  scrollDown();
  return node;
}

function setBusy(on) {
  busy = on;
  $('send').disabled = on;
  setStatus(on ? 'typing…' : STATUS);
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// Reveal bubbles one at a time, like a person texting.
async function reveal(bubbles) {
  for (const [i, b] of bubbles.entries()) {
    if (i) {
      const dots = showTyping();
      await new Promise((r) => setTimeout(r, 450));
      dots.remove();
    }
    addBubble('in', b);
  }
}

async function send(text) {
  text = text.trim();
  if (busy || !text) return;
  $('chips').hidden = true;
  setBusy(true);
  addBubble('out', { type: 'text', text });
  const dots = showTyping();
  try {
    const data = await api('/api/web/chat', { id: webId, text });
    dots.remove();
    await reveal(data.bubbles);
  } catch (err) {
    dots.remove();
    addBubble('in', { type: 'text', text: err.message }).classList.add('error');
  } finally {
    setBusy(false);
  }
}

async function postNow(postId, btn) {
  if (busy) return;
  btn.disabled = true;
  btn.textContent = 'Posting…';
  setBusy(true);
  try {
    const { bubbles } = await api('/api/web/post', { id: webId, postId });
    const ok = bubbles.some((b) => b.text.startsWith('Posted'));
    btn.textContent = ok ? 'Posted ✓' : 'Try again';
    btn.className = ok ? 'btn done' : 'btn primary';
    btn.disabled = ok;
    await reveal(bubbles);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'Try again';
    addBubble('in', { type: 'text', text: err.message }).classList.add('error');
  } finally {
    setBusy(false);
  }
}

function renderChips() {
  $('chips').replaceChildren(...CHIPS.map((c) => {
    const chip = el('button', { type: 'button', className: 'chip', textContent: c });
    chip.onclick = () => {
      // Open-ended chips go into the box to finish; the rest send straight away.
      if (c.endsWith('…')) { $('input').value = c.replace('…', ' '); $('input').focus(); } else send(c);
    };
    return chip;
  }));
  $('chips').hidden = false;
}

async function restore() {
  addBubble('in', { type: 'text', text: GREETING });
  renderChips();
  const res = await fetch(`/api/web/history?id=${webId}`);
  if (!res.ok) return;
  const { messages } = await res.json();
  if (messages.length) $('chips').hidden = true;
  for (const m of messages) {
    if (m.role === 'user') addBubble('out', { type: 'text', text: m.text });
    else m.bubbles.forEach((b) => addBubble('in', b));
  }
}

function setupDictation() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { $('mic').hidden = true; return; }
  const rec = new SR();
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  let listening = false;
  rec.onresult = (e) => { $('input').value = [...e.results].map((r) => r[0].transcript).join(''); };
  rec.onend = () => { listening = false; $('mic').classList.remove('live'); };
  $('mic').onclick = () => {
    if (listening) return rec.stop();
    listening = true; $('mic').classList.add('live'); rec.start();
  };
}

$('form').onsubmit = (e) => { e.preventDefault(); const t = $('input').value; $('input').value = ''; $('input').style.height = 'auto'; send(t); };
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); }
});
$('input').addEventListener('input', () => { const t = $('input'); t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; });
$('new').onclick = () => {
  webId = crypto.randomUUID();
  try { localStorage.setItem(STORAGE_KEY, webId); } catch {}
  $('log').replaceChildren();
  addBubble('in', { type: 'text', text: GREETING });
  renderChips();
};

setupDictation();
restore().catch(() => {});
