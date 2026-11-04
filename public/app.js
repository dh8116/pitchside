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
let online = true; // false while the app can't reach the internet: drafts still work, Post buttons grey out
const OFFLINE_TITLE = "Offline. Posting turns back on when you're online.";
const SESSIONS_KEY = 'pitchside.sessions';

function loadId() {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(STORAGE_KEY, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}
let webId = loadId();

// Earlier conversations. The text lives on the server (per id); the browser only remembers the list.
function loadSessions() {
  try { const list = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? '[]'); return Array.isArray(list) ? list : []; } catch { return []; }
}
function saveSessions(list) { try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, 30))); } catch {} }
function touchSession(id, title) {
  const list = loadSessions();
  const found = list.find((s) => s.id === id);
  if (found) found.at = Date.now();
  else list.unshift({ id, title: (title || 'New chat').slice(0, 60), at: Date.now() });
  saveSessions(list.sort((a, b) => b.at - a.at));
}

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
    btn.dataset.post = '1';
    if (!online) { btn.disabled = true; btn.title = OFFLINE_TITLE; }
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
  touchSession(webId, text);
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
  if (ok) btn.dataset.done = '1';
  btn.disabled = ok || !online;
  if (!ok) checkOnline(); // a refusal because we're offline should grey the buttons straight away
}

function applyOnline() {
  for (const btn of document.querySelectorAll('button[data-post]')) {
    if (btn.dataset.done) continue;
    btn.disabled = !online;
    btn.title = online ? '' : OFFLINE_TITLE;
  }
}

async function checkOnline() {
  let now = navigator.onLine !== false;
  if (now) {
    try {
      const res = await fetch('/api/web/status', { headers: authHeaders() });
      if (res.ok) now = (await res.json()).online !== false;
    } catch { now = false; } // can't even reach this server
  }
  if (now !== online) { online = now; applyOnline(); }
}
setInterval(() => { if (!document.hidden) checkOnline(); }, 8000);
window.addEventListener('online', checkOnline);
window.addEventListener('offline', () => { online = false; applyOnline(); });
checkOnline();

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
  const { messages } = await res.json();
  for (const m of messages) {
    if (m.role === 'user') addMessage('out', { type: 'text', text: m.text });
    else m.bubbles.forEach((b) => addMessage('in', b));
  }
  // A conversation from before the Chats list existed still gets an entry.
  const first = messages.find((m) => m.role === 'user');
  if (first && !loadSessions().some((s) => s.id === webId)) touchSession(webId, first.text);
}

function renderSessions() {
  const nav = $('sessions');
  const list = loadSessions();
  nav.replaceChildren();
  if (!list.length) nav.append(el('p', { textContent: 'No earlier chats yet. Send a message and it shows up here.' }));
  for (const s of list) {
    const btn = el('button', { type: 'button' }, el('b', { textContent: s.title }), el('small', { textContent: new Date(s.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) }));
    if (s.id === webId) btn.setAttribute('aria-current', 'true');
    btn.onclick = () => openSession(s.id);
    nav.append(btn);
  }
}

function toggleSessions(open = $('sessions').hidden) {
  if (open) renderSessions();
  $('sessions').hidden = !open;
  $('chats').setAttribute('aria-expanded', String(open));
}

async function openSession(id) {
  toggleSessions(false);
  if (busy || id === webId) return;
  webId = id;
  try { localStorage.setItem(STORAGE_KEY, webId); } catch {}
  await restore().catch(() => {});
}

$('form').onsubmit = (e) => { e.preventDefault(); const t = $('input').value; $('input').value = ''; $('input').style.height = 'auto'; send(t); };
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('form').requestSubmit(); }
});
$('input').addEventListener('input', () => { const t = $('input'); t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px`; });
$('chats').onclick = () => toggleSessions();
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSessions(false); });
document.addEventListener('click', (e) => { if (!e.target.closest('#sessions, #chats')) toggleSessions(false); });
$('new').onclick = () => {
  toggleSessions(false);
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

// ---- Import: bring in an intro from another AI, a file, or a website ----
const IMPORT_FILE_BYTES = 300_000;
let importFile = null; // { name, text } once a file is chosen

function importStatus(message, isError = false) {
  $('import-status').textContent = message;
  $('import-status').classList.toggle('error', isError);
}

$('import').onclick = () => {
  toggleSessions(false);
  importStatus('');
  $('import-dialog').showModal();
};
$('import-cancel').onclick = () => $('import-dialog').close();

// The prompt to paste into ChatGPT / Claude / Gemini comes from the server, so there is one copy of it.
$('import-ask').addEventListener('toggle', async () => {
  if (!$('import-ask').open || $('import-prompt').value) return;
  try {
    const res = await fetch('/api/web/import-prompt', { headers: authHeaders() });
    $('import-prompt').value = (await res.json()).prompt ?? '';
  } catch { importStatus("Couldn't load the prompt. Check your connection.", true); }
});
$('copy-prompt').onclick = async () => {
  $('import-prompt').select();
  try { await navigator.clipboard.writeText($('import-prompt').value); importStatus('Copied. Paste it into ChatGPT, Claude or Gemini, then paste its answer here.'); }
  catch { importStatus('Select the text above and copy it.'); }
};

$('import-file').onchange = async () => {
  const file = $('import-file').files[0];
  importFile = null;
  if (!file) return importStatus('');
  if (/\.(pdf|docx?|pptx?|xlsx?|zip|png|jpe?g|gif|webp)$/i.test(file.name) || /^(image|audio|video)\//.test(file.type)) {
    $('import-file').value = '';
    return importStatus("I can't read that kind of file here. Save it as .txt or .md, or paste the text.", true);
  }
  try {
    importFile = { name: file.name, text: await file.slice(0, IMPORT_FILE_BYTES).text() };
    importStatus(file.size > IMPORT_FILE_BYTES ? `Loaded the first ${Math.round(IMPORT_FILE_BYTES / 1000)} KB of ${file.name}.` : `Loaded ${file.name}.`);
  } catch { importStatus("Couldn't read that file.", true); }
};

$('import-form').onsubmit = async (e) => {
  e.preventDefault();
  if (busy) return;
  const pasted = $('import-text').value.trim();
  const url = $('import-url').value.trim();
  const jobs = [];
  if (pasted || importFile) {
    jobs.push({ label: importFile?.name ?? 'what you pasted', body: { source: importFile ? 'file' : 'paste', label: importFile?.name ?? '', text: [pasted, importFile?.text].filter(Boolean).join('\n\n') } });
  }
  if (url) jobs.push({ label: url, body: { source: 'url', url } });
  if (!jobs.length) return importStatus('Paste something, add a file, or give a website first.', true);

  setBusy(true);
  $('import-go').disabled = true;
  try {
    for (const job of jobs) {
      importStatus(`Reading ${job.label.slice(0, 60)}…`);
      const { bubbles } = await api('/api/web/import', { id: webId, ...job.body });
      touchSession(webId, 'Imported context');
      addMessage('out', { type: 'text', text: `Import: ${job.label.slice(0, 60)}` });
      bubbles.forEach((b) => addMessage('in', b));
    }
    $('import-text').value = ''; $('import-url').value = ''; $('import-file').value = ''; importFile = null;
    $('import-dialog').close();
  } catch (err) {
    importStatus(err.message, true);
  } finally {
    setBusy(false);
    $('import-go').disabled = false;
  }
};
