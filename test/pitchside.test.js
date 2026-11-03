import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { parseReply, bubbleToText, bubblesToEmail } from '../src/format.js';
import { createCoach, challengeDay, buildMessages } from '../src/coach.js';
import { createUserStore, newUser } from '../src/users.js';
import { createApp } from '../src/app.js';
import { whatsappChannel } from '../src/channels/whatsapp.js';
import { twilioChannel, twilioSignature } from '../src/channels/twilio.js';
import { imessageChannel } from '../src/channels/imessage.js';
import { emailChannel } from '../src/channels/email.js';

const tmpStore = async () => createUserStore(await mkdtemp(path.join(os.tmpdir(), 'pitchside-')));

/** Stands in for the Anthropic client: returns canned replies, records requests. */
function fakeClient(replies) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    beta: {
      messages: {
        stream(body) {
          calls.push(body);
          const next = queue.shift() ?? 'ok';
          const message = typeof next === 'string'
            ? { content: [{ type: 'text', text: next }], stop_reason: 'end_turn' }
            : next;
          return { finalMessage: async () => message };
        },
      },
    },
  };
}

function recordingChannel() {
  const sent = [];
  return { sent, send: async (user, bubbles) => { sent.push({ to: user.address, bubbles }); } };
}

test('parseReply splits paragraphs into bubbles, extracts posts and memories', () => {
  const raw = `Good. Send at 7:30, not tonight.\n\nHere's today's post:\n<post platform="linkedin">Seed-tested my first buyer email.\n\nDay 13 of 30</post>\n<remember>Sells to insurers in NZ</remember>That's the day.`;
  const { bubbles, memories } = parseReply(raw);
  assert.deepEqual(memories, ['Sells to insurers in NZ']);
  assert.deepEqual(bubbles.map((b) => b.type), ['text', 'text', 'post', 'text']);
  assert.equal(bubbles[2].platform, 'linkedin');
  assert.equal(bubbles[2].text, 'Seed-tested my first buyer email.\n\nDay 13 of 30');
  assert.match(bubbles[2].link, /^https:\/\/www\.linkedin\.com\/feed\/\?shareActive=true&text=Seed-tested/);
  assert.match(bubbleToText(bubbles[2]), /tap to post it on LinkedIn: https:/);
  assert.match(bubblesToEmail(bubbles), /Post it on LinkedIn/);
});

test('posts without a platform default to X', () => {
  const { bubbles } = parseReply('<post>shipping today</post>');
  assert.equal(bubbles[0].platform, 'x');
  assert.equal(bubbles[0].link, 'https://x.com/intent/post?text=shipping%20today');
});

test('coach replies, remembers facts, starts the challenge, and delivers via the channel', async () => {
  const users = await tmpStore();
  const client = fakeClient(['Nice. Who buys it?\n\nAnd what have you tried?<remember>Building Acme, an AI voice app</remember>']);
  const wa = recordingChannel();
  const coach = createCoach({ client, users, channels: { whatsapp: wa }, now: () => new Date('2026-11-03T09:00:00Z') });

  const bubbles = await coach.handleInbound({ key: 'whatsapp:+15550001', channel: 'whatsapp', address: '15550001', messageId: 'm1', text: 'I build Acme' });
  assert.equal(bubbles.length, 2);
  assert.equal(wa.sent.length, 1);
  assert.equal(wa.sent[0].to, '15550001');

  const user = await users.get('whatsapp:+15550001');
  assert.deepEqual(user.notes, ['Building Acme, an AI voice app']);
  assert.equal(user.challengeStartedAt, '2026-11-03T09:00:00.000Z');
  assert.equal(user.messages.length, 2);

  const req = client.calls[0];
  assert.equal(req.model, 'claude-opus-5');
  assert.equal(req.fallbacks, 'default');
  assert.match(req.messages.at(-1).content, /^\[Pitchside context · channel: whatsapp/);
  assert.match(req.messages.at(-1).content, /I build Acme$/);
});

test('webhook retries with the same message id are ignored', async () => {
  const users = await tmpStore();
  const client = fakeClient(['one', 'two']);
  const coach = createCoach({ client, users });
  const msg = { key: 'sms:+1', channel: 'twilio', address: '+1', messageId: 'SM1', text: 'hi', deliver: false };
  await coach.handleInbound(msg);
  assert.deepEqual(await coach.handleInbound(msg), []);
  assert.equal(client.calls.length, 1);
});

test('commands are handled without calling the model', async () => {
  const users = await tmpStore();
  const client = fakeClient([]);
  const coach = createCoach({ client, users });
  const base = { key: 'web:x', channel: 'web', address: 'x', deliver: false };
  const [tz] = await coach.handleInbound({ ...base, text: 'timezone Pacific/Auckland' });
  assert.match(tz.text, /Pacific\/Auckland/);
  const [bad] = await coach.handleInbound({ ...base, text: 'timezone Mars/Base' });
  assert.match(bad.text, /don't know/);
  await coach.handleInbound({ ...base, text: 'pause' });
  const user = await users.get('web:x');
  assert.equal(user.timezone, 'Pacific/Auckland');
  assert.equal(user.checkins, false);
  assert.equal(client.calls.length, 0);
});

test('challengeDay counts local calendar days', () => {
  const user = { ...newUser('k', 'web', 'a'), timezone: 'Pacific/Auckland', challengeStartedAt: '2026-11-01T20:00:00Z' }; // Nov 2, 09:00 NZ
  assert.equal(challengeDay(user, new Date('2026-11-02T10:00:00Z')), 1); // Nov 2, 23:00 NZ
  assert.equal(challengeDay(user, new Date('2026-11-02T12:00:00Z')), 2); // Nov 3, 01:00 NZ
});

test('history sent to the model always starts with a user turn', () => {
  const user = newUser('k', 'web', 'a');
  user.messages = [{ role: 'assistant', content: 'stray' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'hey' }];
  const msgs = buildMessages(user, 'next');
  assert.equal(msgs[0].role, 'user');
  assert.equal(msgs.length, 3);
});

test('pause_turn continues the same turn', async () => {
  const users = await tmpStore();
  const client = fakeClient([
    { content: [{ type: 'text', text: 'Looking them up. ' }], stop_reason: 'pause_turn' },
    { content: [{ type: 'text', text: 'I have some bad news.' }], stop_reason: 'end_turn' },
  ]);
  const coach = createCoach({ client, users });
  const bubbles = await coach.handleInbound({ key: 'web:y', channel: 'web', address: 'y', text: 'any competitors?', deliver: false });
  assert.equal(bubbles[0].text, 'Looking them up. I have some bad news.');
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[1].messages.at(-1).role, 'assistant');
});

test('morning check-in goes out once, at the check-in hour, inside the WhatsApp window', async () => {
  const users = await tmpStore();
  let now = new Date('2026-11-03T10:00:00Z');
  const client = fakeClient(['first reply', 'Morning. Today: three buyer emails by 9.']);
  const wa = recordingChannel();
  const coach = createCoach({ client, users, channels: { whatsapp: wa }, now: () => now });
  await coach.handleInbound({ key: 'whatsapp:+1', channel: 'whatsapp', address: '1', text: 'hi' });

  now = new Date('2026-11-04T07:10:00Z'); // 07:00 UTC hour → not 8
  assert.equal(await coach.runCheckins({ hour: 8 }), 0);
  now = new Date('2026-11-04T08:05:00Z'); // within 24h of last message, 8am UTC
  assert.equal(await coach.runCheckins({ hour: 8 }), 1);
  assert.equal(await coach.runCheckins({ hour: 8 }), 0); // already done today
  assert.equal(wa.sent.at(-1).bubbles[0].text, 'Morning. Today: three buyer emails by 9.');

  now = new Date('2026-11-06T08:05:00Z'); // >24h since they last wrote: WhatsApp would reject it
  assert.equal(await coach.runCheckins({ hour: 8 }), 0);
});

test('WhatsApp Cloud webhook: verify handshake, signature check, message parsing', () => {
  const ch = whatsappChannel({ token: 't', phoneNumberId: 'p', verifyToken: 'vt', appSecret: 'sec' });
  const url = new URL('http://h/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=42');
  assert.equal(ch.webhook({ method: 'GET', url, headers: {}, rawBody: Buffer.alloc(0) }).body, '42');

  const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ from: '6421000', id: 'wamid.1', type: 'text', text: { body: 'what to record' } }] } }] }] }));
  const sig = `sha256=${createHmac('sha256', 'sec').update(body).digest('hex')}`;
  const res = ch.webhook({ method: 'POST', url: new URL('http://h/webhooks/whatsapp'), headers: { 'x-hub-signature-256': sig }, rawBody: body });
  assert.deepEqual(res.messages[0], { key: 'whatsapp:+6421000', channel: 'whatsapp', address: '6421000', messageId: 'wamid.1', text: 'what to record' });
  assert.equal(ch.webhook({ method: 'POST', url: new URL('http://h/webhooks/whatsapp'), headers: { 'x-hub-signature-256': 'sha256=bad' }, rawBody: body }).status, 401);
});

test('Twilio webhook: rejects bad signatures, keys SMS and WhatsApp senders separately', async () => {
  const ch = twilioChannel({ accountSid: 'AC1', authToken: 'tok', smsFrom: '+1999', whatsappFrom: 'whatsapp:+1999', publicUrl: 'https://p.example.com', fetchImpl: null });
  const params = { From: 'whatsapp:+15551234', Body: 'hello', MessageSid: 'SM9' };
  const rawBody = Buffer.from(new URLSearchParams(params).toString());
  const url = new URL('http://localhost/webhooks/twilio');
  const sig = twilioSignature('tok', 'https://p.example.com/webhooks/twilio', params);
  const res = ch.webhook({ method: 'POST', url, headers: { 'x-twilio-signature': sig }, rawBody });
  assert.equal(res.messages[0].key, 'whatsapp:+15551234');
  assert.equal(res.messages[0].address, 'whatsapp:+15551234');
  assert.equal(ch.webhook({ method: 'POST', url, headers: { 'x-twilio-signature': 'nope' }, rawBody }).status, 401);

  const sends = [];
  const ch2 = twilioChannel({ accountSid: 'AC1', authToken: 'tok', smsFrom: '+1999', whatsappFrom: 'whatsapp:+1999', publicUrl: 'https://p', gapMs: 0,
    fetchImpl: async (u, init) => { sends.push(Object.fromEntries(init.body)); return new Response('{}'); } });
  await ch2.send({ address: 'whatsapp:+15551234' }, [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]);
  assert.deepEqual(sends.map((s) => [s.From, s.Body]), [['whatsapp:+1999', 'a'], ['whatsapp:+1999', 'b']]);
});

test('iMessage (BlueBubbles) webhook: secret required, ignores own and group messages', () => {
  const ch = imessageChannel({ serverUrl: 'http://bb', password: 'pw', webhookSecret: 's3' });
  const msg = (extra) => Buffer.from(JSON.stringify({ type: 'new-message', data: { guid: 'g1', text: 'yo', isFromMe: false, handle: { address: '+1555' }, chats: [{ guid: 'iMessage;-;+1555' }], ...extra } }));
  const url = new URL('http://h/webhooks/imessage?secret=s3');
  assert.equal(ch.webhook({ method: 'POST', url, rawBody: msg() }).messages[0].address, 'iMessage;-;+1555');
  assert.equal(ch.webhook({ method: 'POST', url, rawBody: msg({ isFromMe: true }) }).messages.length, 0);
  assert.equal(ch.webhook({ method: 'POST', url, rawBody: msg({ chats: [{ guid: 'iMessage;+;chat123' }] }) }).messages.length, 0);
  assert.equal(ch.webhook({ method: 'POST', url: new URL('http://h/webhooks/imessage?secret=x'), rawBody: msg() }).status, 401);
});

test('email webhook: threads replies, ignores auto-replies and our own address', async () => {
  const ch = emailChannel({ serverToken: 't', from: 'Pitchside <coach@example.com>', webhookSecret: 's' });
  const url = new URL('http://h/webhooks/email?secret=s');
  const mail = (extra) => Buffer.from(JSON.stringify({
    FromFull: { Email: 'Jo@Startup.io' }, Subject: 'launch plan', TextBody: 'full', StrippedTextReply: 'we launch friday',
    MessageID: 'pm-1', Headers: [{ Name: 'Message-ID', Value: '<abc@mail>' }], ...extra,
  }));
  const [m] = ch.webhook({ method: 'POST', url, rawBody: mail() }).messages;
  assert.equal(m.key, 'email:jo@startup.io');
  assert.equal(m.text, 'Subject: launch plan\n\nwe launch friday');
  assert.equal(m.meta.emailInReplyTo, '<abc@mail>');
  assert.equal(ch.webhook({ method: 'POST', url, rawBody: mail({ Headers: [{ Name: 'Auto-Submitted', Value: 'auto-replied' }] }) }).messages.length, 0);
  assert.equal(ch.webhook({ method: 'POST', url, rawBody: mail({ FromFull: { Email: 'coach@example.com' } }) }).messages.length, 0);
});

test('HTTP app: web chat round trip and webhook routing', async () => {
  const users = await tmpStore();
  const client = fakeClient(['Hey.\n\nWhat do you sell?']);
  const coach = createCoach({ client, users });
  const app = createApp({ coach, users, channels: {}, publicDir: path.resolve('public'), log: { error() {} } });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const id = '11111111-2222-3333-4444-555555555555';
    const res = await fetch(`${base}/api/web/chat`, { method: 'POST', body: JSON.stringify({ id, text: 'hi' }) });
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).bubbles.map((b) => b.text), ['Hey.', 'What do you sell?']);

    const hist = await (await fetch(`${base}/api/web/history?id=${id}`)).json();
    assert.equal(hist.messages.length, 2);

    assert.equal((await fetch(`${base}/api/web/chat`, { method: 'POST', body: JSON.stringify({ id: '../etc', text: 'x' }) })).status, 400);
    assert.equal((await fetch(`${base}/webhooks/whatsapp`, { method: 'POST', body: '{}' })).status, 404);
    const page = await fetch(`${base}/`);
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.match(await page.text(), /^<!doctype html>/);
    assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  } finally {
    server.close();
  }
});
