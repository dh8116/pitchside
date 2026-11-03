// JSON-file user store. One file per person, keyed by channel identity
// ("whatsapp:+15551234567", "email:jo@example.com", "web:<uuid>").
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_SEEN_IDS = 100;

const fileName = (key) => `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.json`;

export function newUser(key, channel, address) {
  return {
    key,
    channel,             // where we reply: whatsapp | twilio | imessage | email | web
    address,             // channel-specific destination (phone, chat guid, email…)
    timezone: process.env.DEFAULT_TIMEZONE || 'UTC',
    createdAt: new Date().toISOString(),
    challengeStartedAt: null,
    checkins: true,
    lastCheckinDate: null,
    lastInboundAt: null,
    notes: [],
    messages: [],        // { role, content, at }
    seenIds: [],         // inbound message ids already handled (webhook retries)
    meta: {},            // channel extras, e.g. email thread headers
  };
}

export function createUserStore(dir) {
  const file = (key) => path.join(dir, fileName(key));
  return {
    async get(key) {
      try {
        return JSON.parse(await readFile(file(key), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async save(user) {
      await mkdir(dir, { recursive: true });
      user.seenIds = user.seenIds.slice(-MAX_SEEN_IDS);
      const tmp = `${file(user.key)}.tmp`;
      await writeFile(tmp, JSON.stringify(user, null, 2));
      await rename(tmp, file(user.key));
    },
    async *all() {
      let names = [];
      try { names = await readdir(dir); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      for (const n of names) {
        if (!n.endsWith('.json')) continue;
        try { yield JSON.parse(await readFile(path.join(dir, n), 'utf8')); } catch { /* skip corrupt file */ }
      }
    },
  };
}
