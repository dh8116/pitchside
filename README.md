# Pitchside

**An open-source go-to-market coach you text like a friend.** Message it on WhatsApp, iMessage or SMS, or email it, and it helps you get what you're building in front of buyers, one day at a time.

Pitchside follows the "AI friend in your messages" style of coaching: short, decisive texts; a 30-day challenge with a morning check-in; build-in-public posts drafted in your voice with a tap-to-post link; and blunt, specific help with outreach and launches. It deliberately has **no introductions or matchmaking**. It coaches you, and you do the reaching out.

```
You:        no reply yet, and one address bounced
Pitchside:  Two hours of silence means nothing yet. The bounce is the thing to fix.

            Don't guess another address at that company. Call the switchboard
            between 8 and 9, ask who owns customer training, and get the
            right name and email.

            Rest of today: replies, then the demo clip. Nothing else.
```

## What it does

- **Learns your business by text.** One question at a time: product, buyer, stage, which accounts you post from, what you've tried, your goal for the next 30 days.
- **30-day challenge.** Starts when you first message. Every day has one outcome, and it remembers what you committed to. After day 30 it keeps going: same daily outcome and morning check-in, no end date.
- **Morning check-ins.** At 8am your time (configurable), it texts you today's single most important thing.
- **Build-in-public posts.** Drafts short "Day N of 30 with Pitchside" posts (one line per thought) for X, LinkedIn, Threads or Bluesky in your voice, often two options, and says which is stronger. Each comes with a **tap-to-post** link that opens the composer pre-filled.
- **Auto-posting (optional).** Connect X, LinkedIn and/or Bluesky and Pitchside publishes its drafts for you: reply "post it" and it's live. Only the owners you list can post. See [Auto-posting](#auto-posting).
- **Outreach coaching.** Who to target, cold email and DM copy, send timing, deliverability (seed tests, sender identity, bounces), follow-ups, and phone routes when email is blocked.
- **Positioning and launch reviews.** Landing copy, pricing pages, Product Hunt, Hacker News and Reddit plans, and where each will get pushback.
- **Competitor checks.** Uses web search to look up competitors and gives you the news straight, with links.
- **Memory.** Keeps durable facts about you across weeks, stored as plain JSON on your server.
- **Built-in playbooks.** The coach carries a written knowledge base (`src/knowledge.js`) covering the 30-day challenge structure, finding the decision-maker, cold email, deliverability and seed tests, build-in-public posts, positioning, launches (Product Hunt, Hacker News, Reddit), competitors and early pricing. It's plain prose, so edit it to teach the coach your own playbook.

## Models: built on the Meta Model API, runs on free and local ones too

Pitchside is built around the [Meta Model API](https://dev.meta.ai/docs): **Muse Spark** and **Muse Wonder** do the coaching, and Meta's built-in **web search** (search grounding) handles competitor and launch checks. Set any one provider below; with more than one, they chain as automatic fallbacks in this order when one is rate-limited or down (`LLM_PROVIDERS` overrides the order):

| Provider | Cost | Key | Notes |
|---|---|---|---|
| **Meta Model API** | see Meta | [dev.meta.ai/docs](https://dev.meta.ai/docs) | `MODEL_API_KEY`. Default `muse-spark-1.3`; `META_MODEL=muse-wonder-1.0` for Muse Wonder. Web search is built in. Avoid `-contributor` models: Meta may use prompts to improve its products |
| Anthropic Claude | paid | [console.anthropic.com](https://console.anthropic.com) | `ANTHROPIC_API_KEY`. Searches the web by itself |
| Google Gemini | free tier | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | default `gemini-2.5-flash` |
| Groq | free tier | [console.groq.com/keys](https://console.groq.com/keys) | default `openai/gpt-oss-120b`, very fast |
| **Ollama (offline)** | free | [ollama.com](https://ollama.com) | `OLLAMA_MODEL=llama3.1`. A model on your own machine: no key, no internet |
| Anything OpenAI-compatible | varies | `LLM_BASE_URL` + `LLM_MODEL` | OpenRouter, LM Studio, etc. |

Free tiers have rate limits, which is fine for one person or a small group.

### Web search and working offline
- **Meta and Claude search the web natively.** Pitchside turns it on for competitor checks, launch research and pricing questions. `PITCHSIDE_WEB_SEARCH=0` turns it off.
- **Gemini, Groq and Ollama get a `web_search` tool** that Pitchside runs for them. It uses `BRAVE_API_KEY` or `TAVILY_API_KEY` if set (both have free tiers), otherwise a keyless DuckDuckGo lookup (best effort).
- **Offline works, automatically.** Install [Ollama](https://ollama.com) and run `ollama pull qwen2.5:3b`. With a cloud key set, Pitchside switches to the local model on its own when the internet drops, and back when it returns. With no key at all it uses the local model by itself. No `OLLAMA_MODEL` needed (set it to pick a specific model; `OLLAMA_AUTO=0` turns the automatic fallback off). Coaching, memory, check-ins and the browser chat need no internet. Searching is paused and the coach answers from what it knows.
- **Local models get a lighter request** so replies come back in seconds on a laptop: a short coaching prompt, recent history only, a capped reply length and one trimmed search round. The model is loaded when the server starts.
- **Posting waits for a connection.** Drafting keeps working offline and drafts are saved. The Post buttons grey out and "post it" is held until the app is online again, then they work as normal. `ONLINE_CHECK_URL` sets which address is used to check the connection.

### Research briefs
Anything Pitchside looks up (competitors, a market, a prospect) comes back in the same shape every time, so it is quick to scan: a one-line **Verdict**, up to five numbered findings, a **Move** for this week, and an **Unverified** line for anything it couldn't confirm. Every fact ends with the link it came from, and a claim with no source goes under Unverified instead. The prompt carries one hand-built example of the shape, which small local models follow well.

### Bring in what you already have
Tap **Import** in the web chat (or text `import https://yourproduct.com` from any channel):
- **An intro from another AI.** The dialog has a prompt to paste into ChatGPT, Claude or Gemini; paste its answer back and Pitchside skips the questions it can already answer.
- **A note or file** from another app (`.txt`, `.md`, `.csv`, `.json`, `.html`), or **a website**.

Imported text is treated as data, never instructions. A model boils it down to at most 12 short facts, which are cleaned (passwords, keys, emails, phone numbers and "ignore previous instructions" lines are dropped) and shown back to you, numbered. Text `notes` to see everything Pitchside remembers and `forget 3` to remove one. Website imports only fetch public http(s) pages: private, loopback and link-local addresses are refused (checked again on every redirect and at connection time), with a size and time limit. Up to 20 imports a day per person.

### Chat history and sessions
Every conversation is saved on your server (in `DATA_DIR`), so the browser chat restores it on reload. The **Chats** button lists your earlier conversations and reopens any of them; **New** starts a fresh one. On a host that restarts, mount a volume at `DATA_DIR` so history survives.

## Channels

| Channel | Provider | Webhook URL |
|---|---|---|
| WhatsApp | [Meta WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api) | `{PUBLIC_URL}/webhooks/whatsapp` |
| SMS and/or WhatsApp | [Twilio](https://www.twilio.com/docs/messaging) | `{PUBLIC_URL}/webhooks/twilio` |
| iMessage | [BlueBubbles](https://bluebubbles.app) on a Mac | `{PUBLIC_URL}/webhooks/imessage?secret={WEBHOOK_SECRET}` |
| Email | [Postmark](https://postmarkapp.com/developer/webhooks/inbound-webhook) inbound and outbound | `{PUBLIC_URL}/webhooks/email?secret={WEBHOOK_SECRET}` |
| Browser | built in | your server's address (`http://localhost:3000` locally). Set `WEB_CHAT_PASSWORD` on a public server |

A channel turns on when its environment variables are set. Use any combination.

## Quick start

```bash
git clone https://github.com/dh8116/pitchside.git
cd pitchside
npm install
cp .env.example .env      # add MODEL_API_KEY (Meta Model API), or a free GEMINI_API_KEY / GROQ_API_KEY,
                          # or OLLAMA_MODEL to run offline
                          # or fill it in with the .env builder (below)
npm start                 # http://localhost:3000
```

Open the browser chat to try the coach before you wire up any messaging channel. To receive webhooks on your laptop, expose it with a tunnel (e.g. `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and set `PUBLIC_URL` to the tunnel address.

Requires Node 20.12+ and one model key (see the table above).

**Prefer a form?** The [.env builder](https://dh8116.github.io/pitchside/setup/) loads this repo's `.env.example`, explains every setting with a link and a short "How to get this" guide for each key, generates secrets in one click, and gives you a finished `.env` to copy or download, then an **Open the app** button takes you straight to the browser chat once a model is set. It runs entirely in your browser: its security policy blocks every request except fetching the public `.env.example`, so your keys never leave the page. It works for any public repo too: `?repo=owner/name`.

## "I just want to message it": the 15-minute setup

Pitchside has no shared public number. Each person or team runs their own copy, which keeps your conversations on your server. The setup is one-time and needs no coding. After that you just text it.

1. **Get a free model key** from Google AI Studio or Groq (see above).
2. **Deploy:** fork this repo on GitHub, then create a new service from your fork on [Railway](https://railway.com) or [Render](https://render.com). Add `GEMINI_API_KEY` (or `GROQ_API_KEY`), a `WEB_CHAT_PASSWORD`, and a long random `WEBHOOK_SECRET` as environment variables, and attach a disk/volume mounted at `/data` with `DATA_DIR=/data` so memory survives restarts. Copy the public URL it gives you into `PUBLIC_URL`.
3. **Get a WhatsApp number for free:** in [Meta for Developers](https://developers.facebook.com), create an app, add WhatsApp, and use the free **test number** it gives you. Add your own phone as an allowed recipient (the test number can message up to 5 numbers). Copy the token and phone number ID into `WHATSAPP_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID`, pick a `WHATSAPP_VERIFY_TOKEN`, and set the webhook (details below).
4. **Save that number in your phone and say hi.** Or skip step 3 and chat in your browser: open your server's URL and enter your `WEB_CHAT_PASSWORD`.

For SMS, iMessage or email instead, swap step 3 for the matching section below. To open it to more people than the test number allows, register your own business number in Meta's WhatsApp Manager.

## Setting up each channel

### WhatsApp (Meta Cloud API)
1. Create an app at developers.facebook.com, add the **WhatsApp** product, and get a phone number ID and a permanent access token.
2. Set `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET` (App settings → Basic) and pick any `WHATSAPP_VERIFY_TOKEN`.
3. In WhatsApp → Configuration, set the callback URL to `{PUBLIC_URL}/webhooks/whatsapp` with the same verify token, and subscribe to `messages`.

WhatsApp only allows free-form business messages within 24 hours of the person's last message. Pitchside skips a morning check-in if that window has closed. To send check-ins anyway, you'd need an approved message template, which isn't included.

### SMS / WhatsApp (Twilio)
1. Buy a number (and/or enable the WhatsApp sender or sandbox).
2. Set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_SMS_FROM`, `TWILIO_WHATSAPP_FROM`, and `PUBLIC_URL`.
3. Set the number's "A message comes in" webhook (HTTP POST) to `{PUBLIC_URL}/webhooks/twilio`.

Requests are verified with Twilio's `X-Twilio-Signature`, so `PUBLIC_URL` must match exactly what Twilio calls.

### iMessage (BlueBubbles)
Apple doesn't offer an iMessage API. [BlueBubbles](https://bluebubbles.app) is an open-source server that runs on a Mac signed in to iMessage.
1. Install the BlueBubbles server on an always-on Mac and enable the REST API with a password.
2. Set `BLUEBUBBLES_URL` (e.g. `http://mac-mini.local:1234`), `BLUEBUBBLES_PASSWORD` and `WEBHOOK_SECRET`.
3. In BlueBubbles → API & Webhooks, add a webhook for **New Messages** pointing at `{PUBLIC_URL}/webhooks/imessage?secret={WEBHOOK_SECRET}`.

Group chats are ignored. Pitchside only replies in 1:1 conversations.

### Email (Postmark)
1. Create a Postmark server, verify your sending domain, and set `POSTMARK_SERVER_TOKEN` and `EMAIL_FROM`.
2. Under Inbound, set the webhook URL to `{PUBLIC_URL}/webhooks/email?secret={WEBHOOK_SECRET}` and forward your coach address (e.g. `coach@yourdomain.com`) to the inbound address.

Replies stay in the same thread. Auto-replies and mail from Pitchside's own address are ignored, so it never loops.

## Auto-posting

Pitchside can publish the posts it drafts straight to **X**, **LinkedIn** and **Bluesky**. It's off until you set it up, and only the people in `POST_OWNERS` can ever post.

1. Add credentials for the platforms you want (any combination):
   - **X:** create an app at [developer.x.com](https://developer.x.com) with **Read and Write** permission, then set `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` (regenerate the access token after switching to Read and Write).
   - **LinkedIn:** an OAuth access token with `w_member_social` (or `w_organization_social` for a company page) in `LINKEDIN_ACCESS_TOKEN`, and the author URN (`urn:li:person:…` or `urn:li:organization:…`) in `LINKEDIN_AUTHOR`.
   - **Bluesky:** your handle in `BLUESKY_HANDLE` and an [app password](https://bsky.app/settings/app-passwords) (not your real password) in `BLUESKY_APP_PASSWORD`.
2. Set `POST_OWNERS` to who may post, comma-separated: a phone number (`+15551234567`), an email address, a full key such as `whatsapp:+15551234567`, or `web` for the local browser chat.

How it behaves:
- **Default:** when an owner gets a draft, Pitchside asks for confirmation. Reply **`post it`** and it publishes, then sends you the link. If it drafted two options, reply **`post 1`** or **`post 2`**. In the browser chat, each post card has a **Post now** button.
- **`AUTO_POST=1`:** drafts are published the moment they're written. When there are two options for the same platform, it still waits for you to pick one.
- If posting fails (for example, a duplicate post or an expired token), the draft stays saved and the error is shown, so you can fix it and reply `post it` again.
- Everyone else just gets the tap-to-post link, as before.

## Things you can text it

| Text | What happens |
|---|---|
| anything | coaching |
| `timezone Europe/London` | sets your clock for check-ins and "Day N" |
| `pause` / `resume` | turns morning check-ins off/on |
| `restart challenge` | starts a new 30 days today |
| `reset` | forgets the conversation and notes |
| `help` | lists these |
| `post it` / `post 2` | publishes the waiting draft (owners only, see [Auto-posting](#auto-posting)) |

## How it works

```
WhatsApp / Twilio / BlueBubbles / Postmark ──webhook──▶ src/channels/*  (verify + normalise)
                                                              │
                                                              ▼
                                                        src/coach.js  ── Claude (Messages API, web search)
                                                              │           per-person memory + 30-day state
                                                              ▼
                                                        src/format.js  reply → bubbles, <post> → tap-to-post links
                                                              │
                                                              ▼
                                                        src/posting/   owners only: "post it" → X / LinkedIn / Bluesky
                                                              │
                                                              ▼
                                                   channel.send(): one message per bubble, in order
```

- Webhooks are acknowledged immediately and the reply is sent asynchronously, because model calls outlast provider webhook timeouts.
- Messages from one person are processed one at a time, and retried webhooks are de-duplicated by message ID.
- Each person is one JSON file in `DATA_DIR`. Back it up, or swap `src/users.js` for a database.
- The system prompt lives in `src/prompts.js`. Change the coach's personality there.
- `src/llm.js` hides the model provider behind one `complete()` call and chains providers for fallback. On Claude, a declined request is also rerun server-side on a fallback model.
- `src/knowledge.js` holds the coaching playbooks, written from scratch.
- `src/posting/` holds one small client per platform (X uses OAuth 1.0a, LinkedIn the Posts API, Bluesky the AT Protocol), plus the owner check and the confirm-before-posting flow.
- `docs/` is the GitHub Pages site: `index.html` is the landing page and `setup/index.html` is the `.env` builder.

## Deploying

Any host that runs Node and keeps a disk works (Railway, Fly.io, Render, a VPS). A `Dockerfile` is included and stores data in `/data`, so mount a volume there. On a public server, set `WEB_CHAT_PASSWORD` so only people with the passcode can use the browser chat (and your API key). After 10 wrong guesses from one address, the chat locks for 15 minutes. Set `WEB_CHAT=0` to turn the browser chat off entirely.

## Development

```bash
npm test        # node:test, no network or API key needed
npm run dev     # restarts on file changes
```

## Contributing

Issues and PRs are welcome. Good first contributions:
- more channels (Telegram, Slack, Discord, other email providers like Resend or SendGrid)
- a database-backed user store
- WhatsApp message templates so check-ins work outside the 24-hour window
- voice notes (transcribe inbound audio, reply with TTS)

## Disclaimer

Pitchside is an independent open-source project. It is not affiliated with, endorsed by, or derived from the code of any company or product.

## License

[MIT](LICENSE)
