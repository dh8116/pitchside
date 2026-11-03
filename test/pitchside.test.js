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
import { anthropicLLM, openaiCompatibleLLM, metaLLM, chainLLM, llmFromEnv } from '../src/llm.js';
import { createSearch, parseDuckDuckGo } from '../src/search.js';
import { whatsappChannel } from '../src/channels/whatsapp.js';
import { twilioChannel, twilioSignature } from '../src/channels/twilio.js';
import { imessageChannel } from '../src/channels/imessage.js';
import { emailChannel } from '../src/channels/email.js';
import { createPublisher, isOwner, parseOwners } from '../src/posting/index.js';
import { oauth1Header, xPoster } from '../src/posting/x.js';
import { escapeLittleText, linkedinPoster } from '../src/posting/linkedin.js';
import { blueskyPoster, linkFacets } from '../src/posting/bluesky.js';

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
  const coach = createCoach({ llm: anthropicLLM(client), users, channels: { whatsapp: wa }, now: () => new Date('2026-11-03T09:00:00Z') });

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
  const coach = createCoach({ llm: anthropicLLM(client), users });
  const msg = { key: 'sms:+1', channel: 'twilio', address: '+1', messageId: 'SM1', text: 'hi', deliver: false };
  await coach.handleInbound(msg);
  assert.deepEqual(await coach.handleInbound(msg), []);
  assert.equal(client.calls.length, 1);
});

test('commands are handled without calling the model', async () => {
  const users = await tmpStore();
  const client = fakeClient([]);
  const coach = createCoach({ llm: anthropicLLM(client), users });
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
  const coach = createCoach({ llm: anthropicLLM(client), users });
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
  const coach = createCoach({ llm: anthropicLLM(client), users, channels: { whatsapp: wa }, now: () => now });
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

test('after day 30 the challenge keeps going: check-ins continue and the context says so', async () => {
  const users = await tmpStore();
  let now = new Date('2026-11-03T10:00:00Z');
  const client = fakeClient(['first reply', 'Day 45 morning. Today: two follow-ups.']);
  const web = recordingChannel();
  const coach = createCoach({ llm: anthropicLLM(client), users, channels: { whatsapp: web }, now: () => now });
  await coach.handleInbound({ key: 'whatsapp:+2', channel: 'whatsapp', address: '2', text: 'hi' });
  now = new Date('2026-12-17T08:05:00Z'); // day 45
  const user = await users.get('whatsapp:+2');
  user.lastInboundAt = now.toISOString();
  await users.save(user);
  assert.equal(challengeDay(user, now), 45);
  assert.match(buildMessages(user, 'hey', now).at(-1).content, /past day 30, now day 45 and still going/);
  assert.equal(await coach.runCheckins({ hour: 8 }), 1);
});

test('Meta Model API: Responses endpoint with web_search, sources appended, search dropped if rejected', async () => {
  const sent = [];
  const reply = { output: [{ type: 'web_search_call', status: 'completed' }, { type: 'message', content: [{ type: 'output_text', text: 'Rival raised a round.', annotations: [{ type: 'url_citation', url: 'https://a.example/x' }, { type: 'url_citation', url: 'https://a.example/x' }] }] }] };
  const llm = metaLLM({ apiKey: 'k', baseUrl: 'https://api.meta.ai/v1', model: 'muse-spark-1.3',
    fetchImpl: async (url, init) => { const body = JSON.parse(init.body); sent.push({ url, body, auth: init.headers.authorization }); return Response.json(reply); } });
  const text = await llm.complete({ system: 'SYS', webSearch: true, messages: [{ role: 'user', content: 'who is the rival?', at: 'x' }] });
  assert.equal(text, 'Rival raised a round.\n\nSources: https://a.example/x');
  assert.equal(sent[0].url, 'https://api.meta.ai/v1/responses');
  assert.equal(sent[0].auth, 'Bearer k');
  assert.deepEqual(sent[0].body.tools, [{ type: 'web_search' }]);
  assert.deepEqual(sent[0].body.input, [{ role: 'developer', content: 'SYS' }, { role: 'user', content: 'who is the rival?' }]);
  await llm.complete({ system: 'SYS', webSearch: false, messages: [] });
  assert.equal(sent[1].body.tools, undefined);

  const calls = [];
  const picky = metaLLM({ apiKey: 'k', baseUrl: 'https://api.meta.ai/v1', model: 'm', fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body); calls.push(body.tools ? 'with' : 'without');
    return body.tools ? new Response('no tools', { status: 400 }) : Response.json({ output_text: 'plain answer' });
  } });
  assert.equal(await picky.complete({ system: 's', webSearch: true, messages: [] }), 'plain answer');
  assert.deepEqual(calls, ['with', 'without']);
  await picky.complete({ system: 's', webSearch: true, messages: [] });
  assert.deepEqual(calls, ['with', 'without', 'without']);
});

test('search tool for OpenAI-compatible models: runs the tool call, feeds results back, survives offline', async () => {
  const bodies = [];
  const answers = [
    { choices: [{ message: { content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'web_search', arguments: '{"query":"acme pricing"}' } }] } }] },
    { choices: [{ message: { content: 'Acme charges $20.' } }] },
  ];
  const queries = [];
  const llm = openaiCompatibleLLM({ name: 'groq', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm',
    search: async (q) => { queries.push(q); return '1. Acme\nhttps://acme.example\n$20/mo'; },
    fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body)); return Response.json(answers.shift()); } });
  assert.equal(llm.supportsWebSearch, true);
  assert.equal(await llm.complete({ system: 'S', webSearch: true, messages: [{ role: 'user', content: 'acme?' }] }), 'Acme charges $20.');
  assert.deepEqual(queries, ['acme pricing']);
  assert.equal(bodies[0].tools[0].function.name, 'web_search');
  assert.deepEqual(bodies[1].messages.at(-1), { role: 'tool', tool_call_id: 't1', content: '1. Acme\nhttps://acme.example\n$20/mo' });

  // A model that rejects tools is retried as plain chat, and remembered.
  let n = 0;
  const noTools = openaiCompatibleLLM({ name: 'ollama', baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', search: async () => 'x',
    fetchImpl: async (url, init) => { n++; return JSON.parse(init.body).tools ? new Response('tools unsupported', { status: 400 }) : Response.json({ choices: [{ message: { content: 'ok' } }] }); } });
  assert.equal(await noTools.complete({ system: 's', webSearch: true, messages: [] }), 'ok');
  await noTools.complete({ system: 's', webSearch: true, messages: [] });
  assert.equal(n, 3);

  // No search function, or search switched off: no tools offered at all.
  const plain = openaiCompatibleLLM({ name: 'g', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', fetchImpl: async (u, init) => { bodies.push(JSON.parse(init.body)); return Response.json({ choices: [{ message: { content: 'hi' } }] }); } });
  assert.equal(plain.supportsWebSearch, false);
  await plain.complete({ system: 's', webSearch: true, messages: [] });
  assert.equal(bodies.at(-1).tools, undefined);
});

test('web search backends: Brave, Tavily, DuckDuckGo parsing, and a graceful offline message', async () => {
  const brave = createSearch({ env: { BRAVE_API_KEY: 'b' }, fetchImpl: async (url, init) => {
    assert.match(url, /api\.search\.brave\.com.*q=acme%20pricing/); assert.equal(init.headers['x-subscription-token'], 'b');
    return Response.json({ web: { results: [{ title: 'Acme <b>Pricing</b>', url: 'https://acme.example/p', description: 'From $20' }] } });
  } });
  assert.equal(await brave('acme pricing'), '1. Acme Pricing\nhttps://acme.example/p\nFrom $20');
  const tavily = createSearch({ env: { TAVILY_API_KEY: 't' }, fetchImpl: async (url, init) => {
    assert.equal(url, 'https://api.tavily.com/search'); assert.equal(JSON.parse(init.body).query, 'x');
    return Response.json({ results: [{ title: 'T', url: 'https://t.example', content: 'body' }] });
  } });
  assert.match(await tavily('x'), /https:\/\/t\.example/);
  const html = '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.example%2Fpage&amp;rut=1">A <b>page</b></a><a class="result__snippet" href="#">Some &amp; snippet</a>';
  assert.deepEqual(parseDuckDuckGo(html), [{ title: 'A page', url: 'https://a.example/page', snippet: 'Some & snippet' }]);
  const offline = createSearch({ env: {}, fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  assert.match(await offline('anything'), /unavailable right now \(offline or blocked\)/);
  assert.equal(await offline('  '), 'No query given.');
});

test('Ollama runs locally with no key, and the order puts Meta first', () => {
  const ollama = llmFromEnv({ OLLAMA_MODEL: 'llama3.1' });
  assert.equal(ollama.name, 'ollama (llama3.1)');
  assert.equal(ollama.supportsWebSearch, true);
  assert.equal(llmFromEnv({ GEMINI_API_KEY: 'g', OLLAMA_MODEL: 'llama3.1', MODEL_API_KEY: 'm' }).name, 'meta (muse-spark-1.3) → gemini (gemini-2.5-flash) → ollama (llama3.1)');
  assert.equal(llmFromEnv({ GEMINI_API_KEY: 'g', OLLAMA_MODEL: 'llama3.1', LLM_PROVIDERS: 'ollama,gemini' }).name, 'ollama (llama3.1) → gemini (gemini-2.5-flash)');
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
  const coach = createCoach({ llm: anthropicLLM(client), users });
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

test('OpenAI-compatible provider (Gemini/Groq) sends system + history and returns the text', async () => {
  let sent;
  const llm = openaiCompatibleLLM({
    name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k', model: 'm',
    fetchImpl: async (url, init) => { sent = { url, init, body: JSON.parse(init.body) }; return Response.json({ choices: [{ message: { content: 'Ship it.' } }] }); },
  });
  const text = await llm.complete({ system: 'SYS', messages: [{ role: 'user', content: 'hi', at: 'x' }] });
  assert.equal(text, 'Ship it.');
  assert.equal(sent.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, 'Bearer k');
  assert.deepEqual(sent.body.messages, [{ role: 'system', content: 'SYS' }, { role: 'user', content: 'hi' }]);
});

test('provider chain falls through on rate limits but not on bad requests', async () => {
  const failing = (status) => ({ name: `f${status}`, supportsWebSearch: false, complete: async () => { throw Object.assign(new Error('x'), { status }); } });
  const good = { name: 'good', supportsWebSearch: false, complete: async () => 'answer' };
  const quiet = { warn() {} };
  assert.equal(await chainLLM([failing(429), good], { log: quiet }).complete({}), 'answer');
  assert.equal(await chainLLM([failing(503), good], { log: quiet }).complete({}), 'answer');
  await assert.rejects(chainLLM([failing(400), good], { log: quiet }).complete({}), { status: 400 });
});

test('llmFromEnv picks free providers from keys, Claude first when present', () => {
  assert.equal(llmFromEnv({}), null);
  assert.equal(llmFromEnv({ GEMINI_API_KEY: 'g' }).name, 'gemini (gemini-2.5-flash)');
  assert.equal(llmFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q' }).name, 'gemini (gemini-2.5-flash) → groq (openai/gpt-oss-120b)');
  assert.equal(llmFromEnv({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_PROVIDERS: 'groq' }).name, 'groq (openai/gpt-oss-120b)');
  assert.equal(llmFromEnv({ MODEL_API_KEY: 'm' }).name, 'meta (muse-spark-1.3)');
  assert.equal(llmFromEnv({ GROQ_API_KEY: 'q', META_API_KEY: 'm', META_MODEL: 'muse-wonder-1.0' }).name, 'meta (muse-wonder-1.0) → groq (openai/gpt-oss-120b)');
  const withClaude = llmFromEnv({ ANTHROPIC_API_KEY: 'a', GROQ_API_KEY: 'q' }, { createAnthropicClient: () => ({}) });
  assert.match(withClaude.name, /^claude \(claude-opus-5\) → groq/);
  assert.equal(withClaude.supportsWebSearch, true);
});

test('coach system prompt includes the playbook knowledge', async () => {
  let system;
  const llm = { name: 't', complete: async (args) => { system = args.system; return 'ok'; } };
  const coach = createCoach({ llm, users: await tmpStore() });
  await coach.handleInbound({ key: 'web:k', channel: 'web', address: 'k', text: 'hi', deliver: false });
  assert.match(system, /You are Pitchside/);
  assert.match(system, /Seed-test before a real send/);
});

test('echoed context lines never reach the founder or the next model turn', async () => {
  const echo = '[Pitchside context · channel: web · their local time: Tue, 3 Nov 2026, 04:45 (UTC) · challenge: day 1 of 30 · remembered: product: Soulor]';
  assert.deepEqual(parseReply(`${echo}\nI work directly with you.\n\nWhat's the struggle?`).bubbles.map((b) => b.text), ['I work directly with you.', "What's the struggle?"]);
  const user = newUser('k', 'web', 'a');
  user.messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: `${echo}\nhey` }];
  assert.equal(buildMessages(user, 'next')[1].content, 'hey');
});

const fakePoster = (name, results = []) => {
  const posted = [];
  return { posted, name, async post(text) { posted.push(text); const r = results.shift(); if (r instanceof Error) throw r; return { url: `https://${name}/1` }; } };
};

async function postingCoach({ reply, autoPost = false, owners = ['+1555'] }) {
  const users = await tmpStore();
  const x = fakePoster('x.com');
  const bsky = fakePoster('bsky.app');
  const llm = { name: 't', calls: [], complete: async (args) => { llm.calls.push(args); return reply; } };
  const publisher = createPublisher({ posters: { x, bluesky: bsky }, owners, autoPost, log: { error() {} } });
  const coach = createCoach({ llm, users, publisher });
  return { users, x, bsky, llm, coach };
}

test('posting: owner drafts wait for "post it", then publish', async () => {
  const { coach, x, llm, users } = await postingCoach({ reply: 'Here:\n<post platform="x">Shipped day 1.</post>' });
  const msg = (text) => coach.handleInbound({ key: 'sms:+1555', channel: 'twilio', address: '+1555', text, deliver: false });
  const bubbles = await msg('draft my post');
  assert.match(llm.calls[0].messages.at(-1).content, /app can publish to: x, bluesky/);
  assert.equal(bubbles[1].postId, 1);
  assert.match(bubbles.at(-1).text, /Reply "post it" and I'll publish it to X/);
  assert.equal(x.posted.length, 0);

  const [done] = await msg('Post it!');
  assert.equal(done.text, 'Posted to X: https://x.com/1');
  assert.deepEqual(x.posted, ['Shipped day 1.']);
  assert.equal(llm.calls.length, 1);
  assert.deepEqual((await users.get('sms:+1555')).pendingPosts, []);
  assert.match((await msg('post it'))[0].text, /Nothing waiting/);
});

test('posting: non-owners never post and "post it" goes to the coach', async () => {
  const { coach, x, llm } = await postingCoach({ reply: '<post platform="x">hi</post>' });
  const msg = (text) => coach.handleInbound({ key: 'sms:+1999', channel: 'twilio', address: '+1999', text, deliver: false });
  const bubbles = await msg('draft');
  assert.equal(bubbles.length, 1);
  assert.equal(bubbles[0].postId, undefined);
  assert.doesNotMatch(llm.calls[0].messages.at(-1).content, /app can publish/);
  await msg('post it');
  assert.equal(llm.calls.length, 2);
  assert.equal(x.posted.length, 0);
});

test('posting: two options need "post N"; AUTO_POST publishes single drafts at once', async () => {
  const two = await postingCoach({ reply: '<post platform="x">A</post>\n<post platform="x">B</post>' });
  const msg = (text) => two.coach.handleInbound({ key: 'sms:+1555', channel: 'twilio', address: '+1555', text, deliver: false });
  assert.match((await msg('draft')).at(-1).text, /"post 1" to "post 2"/);
  assert.match((await msg('post it'))[0].text, /2 options/);
  await msg('post 2');
  assert.deepEqual(two.x.posted, ['B']);

  const auto = await postingCoach({ reply: '<post platform="bluesky">Day 2 of 30</post>', autoPost: true });
  const bubbles = await auto.coach.handleInbound({ key: 'sms:+1555', channel: 'twilio', address: '+1555', text: 'draft', deliver: false });
  assert.equal(bubbles.at(-1).text, 'Posted to Bluesky: https://bsky.app/1');
  assert.deepEqual(auto.bsky.posted, ['Day 2 of 30']);
  const user = await auto.users.get('sms:+1555');
  assert.match(user.messages.at(-1).content, /Posted to Bluesky/);
});

test('posting: failures keep the draft; owners match keys, addresses and "web"', async () => {
  const { coach, x } = await postingCoach({ reply: '<post platform="x">hi</post>' });
  x.post = async () => { throw new Error('POST api.x.com → 403: duplicate'); };
  const msg = (text) => coach.handleInbound({ key: 'sms:+1555', channel: 'twilio', address: '+1555', text, deliver: false });
  await msg('draft');
  assert.match((await msg('post it'))[0].text, /Couldn't post to X: .*403.*retry/);
  assert.match((await msg('post it'))[0].text, /Couldn't post to X/); // still pending

  assert.equal(isOwner(['jo@startup.io'], 'email:jo@startup.io'), true);
  assert.equal(isOwner(['whatsapp:+1'], 'sms:+1'), false);
  assert.equal(isOwner(['web'], 'web:abc'), true);
  assert.deepEqual(parseOwners(' +1555, Jo@Startup.io ,'), ['+1555', 'jo@startup.io']);
});

test('web "Post now" publishes a held draft and history keeps its button', async () => {
  const { coach, x, users } = await postingCoach({ reply: 'Try:\n<post platform="x">Day 3</post>', owners: ['web'] });
  const app = createApp({ coach, users, channels: {}, publicDir: path.resolve('public'), log: { error() {} } });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const id = '11111111-2222-3333-4444-555555555555';
    const { bubbles } = await (await fetch(`${base}/api/web/chat`, { method: 'POST', body: JSON.stringify({ id, text: 'post idea' }) })).json();
    const postId = bubbles.find((b) => b.type === 'post').postId;
    const hist = await (await fetch(`${base}/api/web/history?id=${id}`)).json();
    assert.equal(hist.messages[1].bubbles.find((b) => b.type === 'post').postId, postId);
    assert.match(hist.messages[1].bubbles.at(-1).text, /post it/);

    const res = await (await fetch(`${base}/api/web/post`, { method: 'POST', body: JSON.stringify({ id, postId }) })).json();
    assert.equal(res.bubbles[0].text, 'Posted to X: https://x.com/1');
    assert.deepEqual(x.posted, ['Day 3']);
    assert.equal((await fetch(`${base}/api/web/post`, { method: 'POST', body: JSON.stringify({ id, postId: 'x' }) })).status, 400);
  } finally {
    server.close();
  }
});

test('platform clients: X OAuth 1.0a signing, LinkedIn escaping, Bluesky facets', async () => {
  const h = oauth1Header({ method: 'POST', url: 'https://api.x.com/2/tweets', consumerKey: 'ck', consumerSecret: 'cs', token: 't', tokenSecret: 'ts', nonce: 'n', timestamp: 1 });
  const base = 'POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&oauth_consumer_key%3Dck%26oauth_nonce%3Dn%26oauth_signature_method%3DHMAC-SHA1%26oauth_timestamp%3D1%26oauth_token%3Dt%26oauth_version%3D1.0';
  const sig = encodeURIComponent(createHmac('sha1', 'cs&ts').update(base).digest('base64'));
  assert.equal(h, `OAuth oauth_consumer_key="ck", oauth_nonce="n", oauth_signature="${sig}", oauth_signature_method="HMAC-SHA1", oauth_timestamp="1", oauth_token="t", oauth_version="1.0"`);

  let sent;
  const xp = xPoster({ apiKey: 'ck', apiSecret: 'cs', accessToken: 't', accessTokenSecret: 'ts', fetchImpl: async (u, init) => { sent = init; return Response.json({ data: { id: '42' } }); } });
  assert.deepEqual(await xp.post('hi'), { url: 'https://x.com/i/web/status/42' });
  assert.equal(JSON.parse(sent.body).text, 'hi');

  assert.equal(escapeLittleText('Day 3 (of 30) #buildinpublic @jo'), 'Day 3 \\(of 30\\) \\#buildinpublic \\@jo');
  const li = linkedinPoster({ accessToken: 'a', author: 'urn:li:person:x', fetchImpl: async (u, init) => { sent = init; return new Response(null, { status: 201, headers: { 'x-restli-id': 'urn:li:share:9' } }); } });
  assert.deepEqual(await li.post('hello'), { url: 'https://www.linkedin.com/feed/update/urn:li:share:9/' });
  assert.equal(sent.headers['linkedin-version'], '202510');

  assert.deepEqual(linkFacets('café https://a.io/x.')[0].index, { byteStart: 6, byteEnd: 20 });
  const calls = [];
  const bs = blueskyPoster({ handle: 'jo.bsky.social', appPassword: 'p', fetchImpl: async (u, init) => {
    calls.push([u, JSON.parse(init.body)]);
    return Response.json(u.endsWith('createSession') ? { accessJwt: 'jwt', did: 'did:plc:1', handle: 'jo.bsky.social' } : { uri: 'at://did:plc:1/app.bsky.feed.post/3abc' });
  } });
  assert.deepEqual(await bs.post('hi'), { url: 'https://bsky.app/profile/jo.bsky.social/post/3abc' });
  assert.equal(calls[1][1].record.text, 'hi');
  await assert.rejects(bs.post('x'.repeat(301)), /300 characters/);
});

test('browser chat passcode: required when set, locks out after repeated wrong guesses', async () => {
  const users = await tmpStore();
  const coach = createCoach({ llm: anthropicLLM(fakeClient(['Hi.'])), users });
  let clock = 0;
  const app = createApp({ coach, users, channels: {}, publicDir: path.resolve('public'), webChatPassword: 's3cret', log: { error() {} }, now: () => clock });
  const server = http.createServer(app).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const id = '11111111-2222-3333-4444-555555555555';
  const hist = (code) => fetch(`${base}/api/web/history?id=${id}`, { headers: code === undefined ? {} : { 'x-pitchside-passcode': code } });
  try {
    const none = await hist();
    assert.equal(none.status, 401);
    assert.equal((await none.json()).passcode, true);
    assert.equal((await hist('s3cret')).status, 200);
    const chat = await fetch(`${base}/api/web/chat`, { method: 'POST', headers: { 'x-pitchside-passcode': 's3cret' }, body: JSON.stringify({ id, text: 'hi' }) });
    assert.equal(chat.status, 200);
    assert.equal((await fetch(`${base}/`)).status, 200); // the page itself loads; only the API is gated

    for (let i = 0; i < 10; i++) assert.equal((await hist('wrong')).status, 401);
    assert.equal((await hist('s3cret')).status, 429); // locked out, even with the right code
    clock += 15 * 60_000;
    assert.equal((await hist('s3cret')).status, 200);
  } finally {
    server.close();
  }
});
