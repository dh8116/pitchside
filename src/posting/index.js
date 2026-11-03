// Auto-posting: publishes the coach's drafted posts straight to X, LinkedIn
// and Bluesky. Only owners (POST_OWNERS) can post. By default a draft waits
// until the owner replies "post it"; AUTO_POST=1 publishes as soon as it's drafted.
import { xPoster } from './x.js';
import { linkedinPoster } from './linkedin.js';
import { blueskyPoster } from './bluesky.js';

const PLATFORM_NAMES = { x: 'X', linkedin: 'LinkedIn', bluesky: 'Bluesky' };
const POST_CMD_RE = /^(?:post|publish)\s+(it|them|now|all|\d{1,2})[\s.!]*$/i;

/** Platform clients for whichever credentials are present. */
export function postersFromEnv(env, { fetchImpl } = {}) {
  const posters = {};
  if (env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_TOKEN_SECRET) {
    posters.x = xPoster({ apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessTokenSecret: env.X_ACCESS_TOKEN_SECRET, fetchImpl });
  }
  if (env.LINKEDIN_ACCESS_TOKEN && env.LINKEDIN_AUTHOR) {
    posters.linkedin = linkedinPoster({ accessToken: env.LINKEDIN_ACCESS_TOKEN, author: env.LINKEDIN_AUTHOR, version: env.LINKEDIN_VERSION || undefined, fetchImpl });
  }
  if (env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD) {
    posters.bluesky = blueskyPoster({ handle: env.BLUESKY_HANDLE, appPassword: env.BLUESKY_APP_PASSWORD, service: env.BLUESKY_SERVICE || undefined, fetchImpl });
  }
  return posters;
}

/**
 * Whether a person may post. Entries match a full key ("whatsapp:+15551234567"),
 * the address part of any key ("+15551234567", "jo@startup.io"), or "web"
 * for the local browser chat.
 */
export function isOwner(owners, key) {
  const k = String(key ?? '').toLowerCase();
  const address = k.slice(k.indexOf(':') + 1);
  return owners.some((o) => o === k || o === address || (o === 'web' && k.startsWith('web:')));
}

export const parseOwners = (list) => String(list ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export function createPublisher({ posters = {}, owners = [], autoPost = false, log = console, now = () => new Date() }) {
  const platformsFor = (user) => (isOwner(owners, user.key) ? Object.keys(posters) : []);

  async function publishOne(user, draft) {
    const name = PLATFORM_NAMES[draft.platform];
    try {
      const { url } = await posters[draft.platform].post(draft.text);
      // Posting one option discards the other drafts for that platform.
      user.pendingPosts = (user.pendingPosts ?? []).filter((p) => p.platform !== draft.platform);
      return { type: 'text', text: url ? `Posted to ${name}: ${url}` : `Posted to ${name}.` };
    } catch (err) {
      log.error(`posting to ${name} failed`, err);
      return { type: 'text', text: `Couldn't post to ${name}: ${err.message.slice(0, 200)}. The draft is still saved; reply "post it" to retry.` };
    }
  }

  /** Publishes drafts and records the exchange so the coach knows what went out. */
  async function publishAll(user, drafts, said) {
    const results = [];
    for (const d of drafts) results.push(await publishOne(user, d));
    const at = now().toISOString();
    user.messages.push({ role: 'user', content: said, at }, { role: 'assistant', content: results.map((b) => b.text).join('\n\n'), at });
    return results;
  }

  return {
    platformsFor,

    /**
     * Runs after the coach replies. Post bubbles on a platform the owner can
     * publish to get a postId (the web chat's "Post now" button) and are either
     * published right away (AUTO_POST) or held for "post it".
     */
    async afterReply(user, bubbles) {
      const platforms = platformsFor(user);
      const drafts = bubbles.filter((b) => b.type === 'post' && platforms.includes(b.platform));
      if (!drafts.length) return bubbles;
      user.postSeq ??= 0;
      user.pendingPosts = drafts.map((b) => {
        b.postId = ++user.postSeq;
        return { id: b.postId, platform: b.platform, text: b.text, at: now().toISOString() };
      });
      const counts = {};
      for (const d of user.pendingPosts) counts[d.platform] = (counts[d.platform] ?? 0) + 1;
      const options = Object.values(counts).some((n) => n > 1);

      // Auto-post only when the choice is unambiguous: never publish two options.
      if (autoPost && !options) {
        const results = [];
        for (const d of [...user.pendingPosts]) results.push(await publishOne(user, d));
        // Appended to the coach's own reply, which the caller stores.
        return [...bubbles, ...results];
      }
      const where = [...new Set(user.pendingPosts.map((d) => PLATFORM_NAMES[d.platform]))].join(' and ');
      const ask = options
        ? `Want me to publish one? Reply "post 1"${user.pendingPosts.length > 1 ? ` to "post ${user.pendingPosts.length}"` : ''} (in the order above).`
        : `Reply "post it" and I'll publish ${user.pendingPosts.length > 1 ? 'these' : 'it'} to ${where}.`;
      return [...bubbles, { type: 'text', text: ask }];
    },

    /** Handles "post it" / "post 2". Returns reply bubbles, or null if it isn't a post command. */
    async command(user, text) {
      const m = text.trim().match(POST_CMD_RE);
      if (!m || !platformsFor(user).length) return null;
      const pending = (user.pendingPosts ?? []).filter((p) => posters[p.platform]);
      if (!pending.length) return [{ type: 'text', text: 'Nothing waiting to post. Ask me for a draft first.' }];
      let chosen;
      if (/^\d+$/.test(m[1])) {
        chosen = pending[Number(m[1]) - 1];
        if (!chosen) return [{ type: 'text', text: `There are ${pending.length} drafts waiting. Pick one from 1 to ${pending.length}.` }];
        chosen = [chosen];
      } else {
        if (new Set(pending.map((p) => p.platform)).size < pending.length) {
          return [{ type: 'text', text: `There are ${pending.length} options. Reply "post 1" to "post ${pending.length}" to choose one.` }];
        }
        chosen = pending;
      }
      return publishAll(user, chosen, text.trim());
    },

    /** Publishes one held draft by id (the web chat's "Post now" button). */
    async publish(user, postId) {
      if (!platformsFor(user).length) return [{ type: 'text', text: "This chat isn't allowed to post. Add it to POST_OWNERS." }];
      const draft = (user.pendingPosts ?? []).find((p) => p.id === postId && posters[p.platform]);
      if (!draft) return [{ type: 'text', text: 'That draft is no longer waiting. Ask me for a fresh one.' }];
      return publishAll(user, [draft], '(tapped "Post now")');
    },
  };
}
