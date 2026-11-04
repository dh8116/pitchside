// Deciding when a message needs the web, and what to search for. Small models rarely call a search tool on
// their own, so for these questions the app searches first and hands over the results.

const NEEDS_WEB = new RegExp([
  String.raw`\b(?:look(?:ing)? (?:it )?up|search(?: the web| online| for)?|google|find out)\b`,
  String.raw`\b(?:competitors?|competition|competing|alternatives? to|rivals?)\b`,
  String.raw`\b(?:vs\.?|versus|compare[sd]?|comparison)\b`,
  String.raw`\b(?:pricing|price of|how much (?:does|is|do)|cost of)\b`,
  String.raw`\b(?:latest|news|recent(?:ly)?|this (?:week|month|year)|trending|just launched|new release)\b`,
  String.raw`\bwho (?:are|is) (?:the )?(?:main|top|biggest|leading)\b`,
  String.raw`\b(?:reviews? of|is .{2,40} (?:legit|worth it|still (?:open|running|accepting)))\b`,
  String.raw`\b(?:accelerator|incubator|cohort|batch ?\d*|enrol(?:l)?|apply(?:ing)? to|worth (?:it|paying))\b`,
  String.raw`\bmarket size\b`,
].join('|'), 'i');

/** True when the message is the kind that is better answered from a fresh search. */
export const wantsResearch = (text) => NEEDS_WEB.test(String(text));

const FILLER = /\b(?:please|can you|could you|look (?:it )?up|look up|search(?: the web)?(?: for)?|google|find out|for me|online)\b/gi;

/** The search query for a message: the message minus the "look it up" talk, or the previous message when little is left. */
export function searchQuery(text, previous = '') {
  const q = String(text).replace(FILLER, ' ').replace(/[?!]+/g, ' ').replace(/\s+/g, ' ').trim();
  return (q.length >= 8 ? q : `${previous} ${q}`.trim()).slice(0, 160);
}
