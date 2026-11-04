// "6m 32s", "45s", "2h 10m": how long a wait is, for people. Shared by the server and the browser.

/** Rounds up, so the wait is never shorter than it really is. */
export function formatWait(totalSeconds) {
  const s = Math.max(1, Math.ceil(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return sec ? `${m}m ${sec}s` : `${m}m`;
  return `${sec}s`;
}
