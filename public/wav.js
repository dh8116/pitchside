// Recording a voice message in the browser for Meta Voice Transcribe: turn microphone samples into the WAV Meta
// accepts (mono, 16-bit, 16 kHz), and notice when the person has stopped talking. Pure functions, no browser APIs.

export const WAV_RATE = 16000;

/** Float32 chunks recorded at inputRate, as a mono 16-bit 16 kHz WAV (an ArrayBuffer). */
export function encodeWav(chunks, inputRate, outRate = WAV_RATE) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const input = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { input.set(c, at); at += c.length; }
  const outLen = Math.floor((total * outRate) / inputRate);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = (i * inputRate) / outRate; const i0 = Math.floor(pos); const frac = pos - i0;
    const sample = input[i0] * (1 - frac) + (input[Math.min(i0 + 1, total - 1)] ?? 0) * frac; // linear interpolation
    pcm[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const tag = (o, s) => { for (let k = 0; k < s.length; k++) v.setUint8(o + k, s.charCodeAt(k)); };
  tag(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, outRate, true);
  v.setUint32(28, outRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

export const rms = (frame) => { let s = 0; for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i]; return Math.sqrt(s / (frame.length || 1)); };

/**
 * Decides when someone has finished speaking. Feed it each frame of samples; it answers "waiting" (no speech yet),
 * "speaking", or "done" (speech, then a long enough silence, or the time limit). The noise floor is learned from the
 * first 300 ms, so a noisy room doesn't count as speech and a quiet one doesn't cut people off.
 */
export function createEndpointer({ rate, silenceMs = 1100, maxMs = 30000, minSpeechMs = 250, floorMs = 300 }) {
  let t = 0; let floor = 0; let floorN = 0; let speechMs = 0; let silentMs = 0; let spoke = false;
  return {
    get heardSpeech() { return spoke; },
    push(frame) {
      const ms = (frame.length / rate) * 1000; const level = rms(frame);
      t += ms;
      if (t <= floorMs) { floor = (floor * floorN + level) / (floorN + 1); floorN += 1; return 'waiting'; }
      const loud = level > Math.max(0.012, floor * 3);
      if (loud) { speechMs += ms; silentMs = 0; if (speechMs >= minSpeechMs) spoke = true; } else if (spoke) { silentMs += ms; }
      if (t >= maxMs) return 'done';
      if (spoke && silentMs >= silenceMs) return 'done';
      return spoke ? 'speaking' : 'waiting';
    },
  };
}
