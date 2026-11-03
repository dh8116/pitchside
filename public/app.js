const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'pitchside.webId';
const PASSCODE_KEY = 'pitchside.passcode';
const PLATFORM = { x: 'X', linkedin: 'LinkedIn', threads: 'Threads', bluesky: 'Bluesky' };
const LIMIT = { x: 280, bluesky: 300, threads: 500, linkedin: 3000 };
const CHIPS = [
  "Draft today's build-in-public post",
  'Who should I cold email first?',
  'Review my landing page copy',
  'Plan my launch week',
];

let busy = false;

function loadId() {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(STORAGE_KEY, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}
let webId = loadId();

// Only needed when the server sets WEB_CHAT_PASSWORD. Remembered on this device.
let passcode = '';
try { passcode = localStorage.getItem(PASSCODE_KEY) ?? ''; } catch {}
const authHeaders = () => (passcode ? { 'x-pitchside-passcode': passcode } : {});

function lock(message = '') {
  $('empty').hidden = true;
  $('log').replaceChildren();
  $('gate').hidden = false;
  $('gate-error').textContent = message;
  $('input').disabled = true;
  $('send').disabled = true;
  $('passcode').focus();
}

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

function scrollDown() { $('scroll').scrollTop = $('scroll').scrollHeight; }

function postCard(bubble) {
  const name = PLATFORM[bubble.platform] ?? bubble.platform;
  const length = [...new Intl.Segmenter().segment(bubble.text)].length;
  const limit = LIMIT[bubble.platform];
  const footer = el('footer');
  if (bubble.postId) {
    const btn = el('button', { type: 'button', className: 'btn primary', textContent: `Post to ${name}` });
    btn.onclick = () => postNow(bubble.postId, btn);
    footer.append(btn);
  }
  footer.append(el('a', { className: 'btn', href: bubble.link, target: '_blank', rel: 'noopener', textContent: `Open in ${name}` }));
  return el('article', { className: 'card' },
    el('header', {}, el('b', { textContent: `${name} post` }),
      el('span', { className: limit && length > limit ? 'over' : '', textContent: limit ? `${length}/${limit}` : `${length}` })),
    linkify(el('div', { className: 'body' }), bubble.text),
    footer);
}

function addMessage(side, bubble) {
  $('empty').hidden = true;
  const node = bubble.type === 'post' ? postCard(bubble) : linkify(el('div', { className: `msg ${side}` }), bubble.text);
  $('log').append(node);
  scrollDown();
  return node;
}

function showTyping() {
  const node = el('div', { className: 'msg in typing', ariaLabel: 'Pitchside is typing' }, el('i'), el('i'), el('i'));
  $('log').append(node);
  scrollDown();
  return node;
}

function setBusy(on) {
  busy = on;
  $('send').disabled = on;
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (data.passcode) { lock(passcode ? 'That passcode didn\'t work.' : ''); throw new Error('Enter the passcode to keep chatting.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function run(request) {
  setBusy(true);
  const dots = showTyping();
  try {
    const { bubbles } = await request();
    dots.remove();
    bubbles.forEach((b) => addMessage('in', b));
    return bubbles;
  } catch (err) {
    dots.remove();
    addMessage('in', { type: 'text', text: err.message }).classList.add('error');
    return null;
  } finally {
    setBusy(false);
  }
}

function send(text) {
  text = text.trim();
  if (busy || !text) return;
  addMessage('out', { type: 'text', text });
  run(() => api('/api/web/chat', { id: webId, text }));
}

async function postNow(postId, btn) {
  if (busy) return;
  btn.disabled = true;
  btn.textContent = 'Posting…';
  const bubbles = await run(() => api('/api/web/post', { id: webId, postId }));
  const ok = bubbles?.some((b) => b.text.startsWith('Posted'));
  btn.textContent = ok ? 'Posted' : 'Try again';
  btn.className = ok ? 'btn done' : 'btn primary';
  btn.disabled = ok;
}

function reset() {
  $('log').replaceChildren();
  $('empty').hidden = false;
  $('chips').replaceChildren(...CHIPS.map((c) => {
    const chip = el('button', { type: 'button', className: 'chip', textContent: c });
    chip.onclick = () => send(c);
    return chip;
  }));
}

async function restore() {
  reset();
  const res = await fetch(`/api/web/history?id=${webId}`, { headers: authHeaders() });
  if (res.status === 401) return lock(passcode ? 'That passcode didn\'t work.' : '');
  if (res.status === 429) return lock((await res.json()).error);
  if (!res.ok) return;
  $('gate').hidden = true;
  $('input').disabled = false;
  $('send').disabled = false;
  for (const m of (await res.json()).messages) {
    if (m.role === 'user') addMessage('out', { type: 'text', text: m.text });
    else m.bubbles.forEach((b) => addMessage('in', b));
  }
}

$('form').onsubmit = (e) => { e.preventDefault(); const t = $('input').value; $('input').value = ''; $('input').style.height = 'auto'; send(t); };
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); }
});
$('input').addEventListener('input', () => { const t = $('input'); t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; });
$('new').onclick = () => {
  webId = crypto.randomUUID();
  try { localStorage.setItem(STORAGE_KEY, webId); } catch {}
  reset();
  $('input').focus();
};

$('gate').onsubmit = (e) => {
  e.preventDefault();
  passcode = $('passcode').value.trim();
  try { localStorage.setItem(PASSCODE_KEY, passcode); } catch {}
  $('passcode').value = '';
  restore().catch(() => {});
};

restore().catch(() => {});
