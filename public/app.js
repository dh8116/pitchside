const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'pitchside.webId';
const GREETING = "Hey, I'm Pitchside. I help you get what you're building in front of buyers, one day at a time. What are you working on?";
const PLATFORM = { x: 'X', linkedin: 'LinkedIn', threads: 'Threads' };

let busy = false;

function loadId() {
  try {
    let id = localStorage.getItem(STORAGE_KEY);
    if (!id) { id = crypto.randomUUID(); localStorage.setItem(STORAGE_KEY, id); }
    return id;
  } catch { return crypto.randomUUID(); }
}
let webId = loadId();

// Plain text with bare URLs turned into links. No HTML from the model is trusted.
function linkify(el, text) {
  const parts = text.split(/(https?:\/\/[^\s)]*[^\s).,!?:;])/g);
  for (const [i, part] of parts.entries()) {
    if (i % 2) {
      const a = Object.assign(document.createElement('a'), { href: part, textContent: part, target: '_blank', rel: 'noopener' });
      el.append(a);
    } else if (part) {
      el.append(part);
    }
  }
}

function addBubble(side, bubble) {
  const el = document.createElement('div');
  el.className = `bubble ${side}`;
  if (bubble.type === 'post') {
    el.classList.add('post');
    linkify(el, bubble.text);
    el.append(document.createElement('br'));
    el.append(Object.assign(document.createElement('a'), {
      className: 'tap', href: bubble.link, target: '_blank', rel: 'noopener',
      textContent: `Tap to post on ${PLATFORM[bubble.platform] ?? bubble.platform} →`,
    }));
  } else {
    linkify(el, bubble.text);
  }
  $('log').append(el);
  $('log').scrollTop = $('log').scrollHeight;
  return el;
}

function setBusy(on) {
  busy = on;
  $('send').disabled = on;
  $('status').textContent = on ? 'typing…' : 'your go-to-market coach';
}

async function send(text) {
  text = text.trim();
  if (busy || !text) return;
  setBusy(true);
  addBubble('out', { type: 'text', text });
  try {
    const res = await fetch('/api/web/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: webId, text }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    // Reveal bubbles one at a time, like a person texting.
    for (const [i, b] of data.bubbles.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 500));
      addBubble('in', b);
    }
  } catch (err) {
    addBubble('in', { type: 'text', text: err.message }).classList.add('error');
  } finally {
    setBusy(false);
  }
}

async function restore() {
  addBubble('in', { type: 'text', text: GREETING });
  const res = await fetch(`/api/web/history?id=${webId}`);
  if (!res.ok) return;
  for (const m of (await res.json()).messages) {
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
  $('log').innerHTML = '';
  addBubble('in', { type: 'text', text: GREETING });
};

setupDictation();
restore().catch(() => {});
