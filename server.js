import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { createApp } from './src/app.js';
import { createCoach } from './src/coach.js';
import { llmFromEnv } from './src/llm.js';
import { createPublisher, postersFromEnv, parseOwners } from './src/posting/index.js';
import { createUserStore } from './src/users.js';
import { whatsappChannel } from './src/channels/whatsapp.js';
import { twilioChannel } from './src/channels/twilio.js';
import { imessageChannel } from './src/channels/imessage.js';
import { emailChannel } from './src/channels/email.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;
const port = Number(env.PORT ?? 3000);

const llm = llmFromEnv(env, { createAnthropicClient: () => new Anthropic() });
if (!llm) {
  console.error(`No model provider configured. Add one of these to .env (free options first):
  GEMINI_API_KEY     free at https://aistudio.google.com/apikey
  GROQ_API_KEY       free at https://console.groq.com/keys
  MODEL_API_KEY      Meta Model API (Muse Spark / Wonder): https://dev.meta.ai/docs
  OLLAMA_MODEL       a local model, works offline: https://ollama.com
  ANTHROPIC_API_KEY  paid, best quality, enables web search`);
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
  ? createPublisher({ posters, owners: postOwners, autoPost: env.AUTO_POST === '1' })
  : null;

const users = createUserStore(path.resolve(env.DATA_DIR ?? path.join(here, 'data')));
const coach = createCoach({
  llm,
  users,
  channels,
  publisher,
  webSearch: env.PITCHSIDE_WEB_SEARCH !== '0',
});

const handler = createApp({
  coach,
  users,
  channels,
  publicDir: path.join(here, 'public'),
  webChat: env.WEB_CHAT !== '0',
  webChatPassword: env.WEB_CHAT_PASSWORD ?? '',
});

http.createServer(handler).listen(port, () => {
  const on = Object.keys(channels);
  console.log(`Pitchside is running at http://localhost:${port}`);
  console.log(`Model: ${llm.name}`);
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
const checkinHour = Number(env.CHECKIN_HOUR ?? 8);
if (env.CHECKINS !== '0') {
  setInterval(() => {
    coach.runCheckins({ hour: checkinHour }).catch((err) => console.error('check-ins failed', err));
  }, 10 * 60_000).unref();
}
