// LinkedIn via the Posts API (https://learn.microsoft.com/linkedin/marketing/community-management/shares/posts-api).
// Needs an OAuth access token with w_member_social (or w_organization_social
// for a company page) and the author URN: urn:li:person:… or urn:li:organization:…
import { request } from '../channels/util.js';

const POSTS_URL = 'https://api.linkedin.com/rest/posts';

// Post text is "little text": these characters must be escaped or the post is cut off.
export const escapeLittleText = (text) => text.replace(/[\\|{}@[\]()<>#*_~]/g, (c) => `\\${c}`);

export function linkedinPoster({ accessToken, author, version = '202510', fetchImpl = fetch }) {
  return {
    name: 'LinkedIn',
    async post(text) {
      const res = await request(fetchImpl, POSTS_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
          'linkedin-version': version,
          'x-restli-protocol-version': '2.0.0',
        },
        body: JSON.stringify({
          author,
          commentary: escapeLittleText(text),
          visibility: 'PUBLIC',
          distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        }),
      });
      const urn = res.headers.get('x-restli-id');
      return { url: urn ? `https://www.linkedin.com/feed/update/${urn}/` : null };
    },
  };
}
