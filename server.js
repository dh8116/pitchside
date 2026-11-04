import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './src/app.js';
import { createCoach } from './src/coach.js';
import { readFileSync } from 'node:fs';
import { llmFromEnv, listOllamaModels, pickLocalModel, FREE_PROVIDERS, META_PROVIDER } from './src/llm.js';
import { cleanKey, keyProblem, keySources, envFileConflicts, probeKey, keyLine } from './src/keys.js';
import { createConnectivity } from './src/connectivity.js';
import { createSearch } from './src/search.js';
import { COACH_PROMPT_LITE } from './src/prompts.js';
import { createPublisher, postersFromEnv, parseOwners, isOwner } from './src/posting/index.js';
import { createUserStore } from './src/users.js';
import { whatsappChannel } from './src/channels/whatsapp.js';
import { twilioChannel } from './src/channels/twilio.js';
import { twilioVoice } from './src/channels/voice.js';
import { imessageChannel } from './src/channels/imessage.js';
import { emailChannel } from './src/channels/email.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const port = Number(env.PORT ?? 3000);

// Online or offline: learned from real traffic, so cloud models give way to a local one and posting pauses.
const connectivity = createConnectivity({ checkUrls: env.ONLINE_CHECK_URL ? [env.ONLINE_CHECK_URL] : undefined });
// With a cloud key set, an installed Ollama model quietly backs it up for when the internet drops
// (OLLAMA_AUTO=0 turns that off). With no keys at all, an installed Ollama model is used on its own.
const autoLocal = env.OLLAMA_AUTO !== '0';
const llmOptions = { createAnthropicClient: () => new Anthropic(), connectivity, autoLocal };
let llm = llmFromEnv(env, llmOptions);
if (!llm && autoLocal) {
  const model = pickLocalModel(await listOllamaModels(env.OLLAMA_BASE_URL));
  if (model) llm = llmFromEnv({ ...env, OLLAMA_MODEL: model }, llmOptions);
}
if (!llm) {
  console.error(`No model provider configured. Add one of these to .env (free options first):
  GEMINI_API_KEY     free at https://aistudio.google.com/apikey
  GROQ_API_KEY       free at https://console.groq.com/keys
  MODEL_API_KEY      Meta Model API (Muse Spark / Wonder): https://dev.meta.ai/docs
  OLLAMA_MODEL       a local model, works offline: https://ollama.com
  ANTHROPIC_API_KEY  paid, best quality, enables web search
Or install Ollama and run "ollama pull qwen2.5:3b": it is found and used automatically, even offline.`);
  process.exit(1);
}

// A channel is turned on when its settings are present.
const channels = {};
if (env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID) {
  channels.whatsapp = whatsappChannel({
    token: env.WHATSAPP_TOKEN,
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.WHATSAPP_APP_SECRET,
  });
}
if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.PUBLIC_URL) {
  channels.twilio = twilioChannel({
    accountSid: env.TWILIO_ACCOUNT_SID,
    authToken: env.TWILIO_AUTH_TOKEN,
    smsFrom: env.TWILIO_SMS_FROM,
    whatsappFrom: env.TWILIO_WHATSAPP_FROM,
    publicUrl: env.PUBLIC_URL,
  });
  // Phone calls on the same Twilio account: point a number's "A call comes in" webhook at {PUBLIC_URL}/webhooks/voice.
  if (env.VOICE_CALLS !== '0') {
    channels.voice = twilioVoice({
      authToken: env.TWILIO_AUTH_TOKEN,
      publicUrl: env.PUBLIC_URL,
      voice: env.TWILIO_VOICE_NAME || undefined,
      language: env.TWILIO_VOICE_LANGUAGE || undefined,
    });
  }
}
if (env.BLUEBUBBLES_URL && env.BLUEBUBBLES_PASSWORD) {
  channels.imessage = imessageChannel({
    serverUrl: env.BLUEBUBBLES_URL,
    password: env.BLUEBUBBLES_PASSWORD,
    webhookSecret: env.WEBHOOK_SECRET,
  });
}
if (env.POSTMARK_SERVER_TOKEN && env.EMAIL_FROM) {
  channels.email = emailChannel({
    serverToken: env.POSTMARK_SERVER_TOKEN,
    from: env.EMAIL_FROM,
    webhookSecret: env.WEBHOOK_SECRET,
  });
}

const posters = postersFromEnv(env);
const postOwners = parseOwners(env.POST_OWNERS);
const publisher = Object.keys(posters).length && postOwners.length
  ? createPublisher({ posters, owners: postOwners, autoPost: env.AUTO_POST === '1', connectivity })
  : null;

// Is each model key what you think it is? One line per key: the last four characters the app really loaded, what was
// cleaned off it (quotes, spaces, "Bearer "), anything that looks wrong, and whether the provider accepts it.
const KEY_SOURCES = keySources(env, { meta: META_PROVIDER.baseUrl, groq: FREE_PROVIDERS.groq.baseUrl, gemini: FREE_PROVIDERS.gemini.baseUrl });
async function checkKeys({ probe = true } = {}) {
  const lines = [];
  for (const k of KEY_SOURCES) {
    if (!env[k.envName]) continue;
    const { key, fixes } = cleanKey(env[k.envName]);
    const result = probe && k.baseUrl ? await probeKey({ baseUrl: k.baseUrl, apiKey: key }) : null;
    lines.push(keyLine({ label: k.label, envName: k.envName, apiKey: key, fixes, problem: keyProblem(k.provider, key), probe: result }));
  }
  return lines;
}
// The .env file is loaded without overriding anything already set, so a variable in your shell silently beats it.
function envConflicts() {
  try { return envFileConflicts(readFileSync(path.resolve('.env'), 'utf8'), env); } catch { return []; }
}
const admins = parseOwners(env.ADMINS || env.POST_OWNERS);

const users = createUserStore(path.resolve(env.DATA_DIR ?? path.join(here, 'data')));
const coach = createCoach({
  llm,
  users,
  channels,
  publisher,
  connectivity,
  keysReport: () => checkKeys(),
  isAdmin: (user) => isOwner(admins, user.key),
  searcher: createSearch({ env }),
  webSearch: env.PITCHSIDE_WEB_SEARCH !== '0',
});

const handler = createApp({
  coach,
  users,
  channels,
  publicDir: path.join(here, 'public'),
  webChat: env.WEB_CHAT !== '0',
  webChatPassword: env.WEB_CHAT_PASSWORD ?? '',
  connectivity,
  setupUrl: env.SETUP_URL || undefined,
});

http.createServer(handler).listen(port, () => {
  const on = Object.keys(channels);
  console.log(`Pitchside is running at http://localhost:${port}`);
  console.log(`Model: ${llm.name}`);
  // Load a local model into memory now, so the first message after the internet drops isn't a cold start.
  for (const c of envConflicts()) {
    console.warn(`WARNING: ${c.name} is set in your shell or environment${c.envHint ? ` (${c.envHint})` : ''} and differs from .env${c.fileHint ? ` (${c.fileHint})` : ''}. The app uses the shell's value, so the change in .env is ignored. Unset it (e.g. unset ${c.name}) and restart.`);
  }
  checkKeys().then((lines) => { for (const l of lines) console.log(`Key check: ${l}`); }).catch(() => {});
  Promise.resolve(llm.warm?.(COACH_PROMPT_LITE)).catch(() => {});
  connectivity.check().then((online) => { if (!online) console.log('Offline: using the local model; posting is paused until the connection is back.'); });
  console.log(`Channels: ${on.length ? on.join(', ') : 'none configured (web chat only)'}`);
  if (env.WEB_CHAT !== '0') {
    console.log(env.WEB_CHAT_PASSWORD
      ? 'Browser chat: on, passcode required'
      : 'Browser chat: on with no passcode. Fine on your laptop; set WEB_CHAT_PASSWORD before deploying.');
  }
  if (publisher) console.log(`Auto-posting: ${Object.keys(posters).join(', ')} for ${postOwners.length} owner(s), ${env.AUTO_POST === '1' ? 'immediately' : 'after "post it"'}`);
  else if (Object.keys(posters).length) console.log('Auto-posting: platform keys found but POST_OWNERS is empty, so nobody can post');
});

// Morning check-ins: every 10 minutes, message anyone whose local time is the
// check-in hour and who hasn't had one today.
// Posts queued while offline go out by themselves once the connection is back.
if (publisher) {
  setInterval(() => {
    coach.flushQueuedPosts().catch((err) => console.error('queued posts failed', err));
  }, 30_000).unref();
}

const checkinHour = Number(env.CHECKIN_HOUR ?? 8);
if (env.CHECKINS !== '0') {
  setInterval(() => {
    coach.runCheckins({ hour: checkinHour, nudgeHour: Number(env.NUDGE_HOUR ?? 17) }).catch((err) => console.error('check-ins failed', err));
  }, 10 * 60_000).unref();
}
