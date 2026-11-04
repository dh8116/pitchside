// Phone calls via Twilio Voice: call your Pitchside number and talk to the coach.
// Point the number's "A call comes in" webhook (HTTP POST) at  {PUBLIC_URL}/webhooks/voice
// Twilio does the listening (<Gather input="speech">) and the speaking (<Say>), so no extra speech service is
// needed. A caller is the same person as their SMS/WhatsApp number, so memory and the 30-day challenge carry over.
// The model can take longer than Twilio waits for a webhook, so the reply is worked out in the background while
// the call hums along with short <Pause> + <Redirect> polls.
import { createHash } from 'node:crypto';
import { bubblesToSpeech, isGoodbye } from '../../public/speech.js';
import { twilioSignature } from './twilio.js';
import { deny, safeEqual } from './util.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xml = (body) => ({ status: 200, headers: { 'content-type': 'text/xml' }, body: `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, messages: [] });
const PHONE_RE = /^\+\d{6,15}$/;

export function twilioVoice({ authToken, publicUrl, voice = 'Polly.Joanna', language = 'en-US', maxPolls = 20, pollSeconds = 3, maxSayChars = 1000, jobTtlMs = 300_000 }) {
  const base = publicUrl.replace(/\/$/, '');
  const jobs = new Map(); // CallSid -> { done, bubbles, failed }

  const say = (text) => `<Say voice="${esc(voice)}" language="${esc(language)}">${esc(text)}</Say>`;
  const turnUrl = (silent = 0) => `${base}/webhooks/voice/turn${silent ? `?silent=${silent}` : ''}`; // silent: how many quiet rounds so far
  // Speaking inside <Gather> lets the caller talk over it. If they say nothing, fall through to the silence handler.
  const gather = (inner, silent = 0) => `<Gather input="speech" action="${esc(turnUrl())}" method="POST" speechTimeout="auto" language="${esc(language)}">${inner}</Gather><Redirect method="POST">${esc(turnUrl(silent + 1))}</Redirect>`;
  const hangup = (text) => xml(`${say(text)}<Hangup/>`);

  async function startJob(coach, sid, number, text) {
    const job = { done: false, bubbles: null, failed: false };
    jobs.set(sid, job);
    setTimeout(() => jobs.delete(sid), jobTtlMs).unref?.();
    coach.handleInbound({
      key: `sms:${number}`, channel: 'twilio', address: number, text, deliver: false,
      messageId: `${sid}:${createHash('sha1').update(text).digest('hex').slice(0, 10)}`,
    }).then((bubbles) => { job.bubbles = bubbles; }, () => { job.failed = true; }).finally(() => { job.done = true; });
  }

  const poll = (sid, n) => xml(`${say('Mm.')}<Pause length="${pollSeconds}"/><Redirect method="POST">${esc(`${base}/webhooks/voice/poll?sid=${encodeURIComponent(sid)}&n=${n}`)}</Redirect>`);

  return {
    name: 'voice',

    async handle({ method, url, headers, rawBody, coach }) {
      if (method !== 'POST') return deny(405);
      const params = Object.fromEntries(new URLSearchParams(rawBody.toString('utf8')));
      const fullUrl = `${base}${url.pathname}${url.search}`;
      if (!safeEqual(headers['x-twilio-signature'], twilioSignature(authToken, fullUrl, params))) return deny(401);

      const number = String(params.From ?? '');
      if (!PHONE_RE.test(number)) return hangup("I can't take calls from hidden numbers. Text me instead, or call from a number that shows.");
      const sid = String(params.CallSid ?? '');

      if (url.pathname === '/webhooks/voice') return xml(gather(say('Hi, Pitchside here. What is on your mind?')));

      if (url.pathname === '/webhooks/voice/turn') {
        const heard = String(params.SpeechResult ?? '').trim();
        if (!heard) {
          const silent = Number(url.searchParams.get('silent') ?? 0);
          return silent >= 2
            ? hangup("I didn't hear anything, so I will let you go. Call back any time.")
            : xml(gather(say(silent ? "Sorry, I didn't catch that. What is on your mind?" : 'Are you still there?'), silent));
        }
        if (isGoodbye(heard)) return hangup('Talk soon.');
        await startJob(coach, sid, number, heard);
        return xml(`${say('One moment.')}<Pause length="1"/><Redirect method="POST">${esc(`${base}/webhooks/voice/poll?sid=${encodeURIComponent(sid)}&n=1`)}</Redirect>`);
      }

      if (url.pathname === '/webhooks/voice/poll') {
        const polled = String(url.searchParams.get('sid') ?? '');
        const n = Number(url.searchParams.get('n') ?? 1);
        const job = jobs.get(polled);
        if (!job) return xml(gather(say('Sorry, I lost track of that. Say it again?')));
        if (!job.done) {
          if (n >= maxPolls) { jobs.delete(polled); return xml(gather(say('That is taking too long. Ask me again in a moment.'))); }
          return poll(polled, n + 1);
        }
        jobs.delete(polled);
        if (job.failed) return xml(gather(say('Sorry, something went wrong on my side. Try again.')));
        return xml(gather(say(bubblesToSpeech(job.bubbles, { maxChars: maxSayChars }) || 'Done.')));
      }

      return deny(404);
    },
  };
}
