// The voice bar: talk to Pitchside, hear it reply, or stay on a hands-free call.
// All of it runs in the browser (Web Speech API), so it costs nothing and needs no account. Speaking replies
// works offline with the device's own voices; listening is on-device in Safari and Edge, and in Chrome it needs
// a connection, which the bar says plainly instead of failing silently.
import { bubblesToSpeech, speechChunks, isGoodbye } from './speech.js';

const SR = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;
const synth = globalThis.speechSynthesis;
export const voiceSupport = { listen: Boolean(SR), speak: Boolean(synth) };

const MAX_SILENT_ROUNDS = 3; // a call ends after this many listens with nothing said

/**
 * @param {object} o
 * @param {(text: string) => void} o.send          sends a message into the chat
 * @param {(text: string) => void} o.fill          puts dictated text in the message box
 * @param {() => boolean} o.isBusy                 true while a reply is being fetched
 * @param {(state: object) => void} o.onState      { listening, calling, readAloud, status, error }
 */
export function createVoice({ send, fill, isBusy, onState, storage = globalThis.localStorage }) {
  let readAloud = false;
  try { readAloud = storage?.getItem('pitchside.readAloud') === '1'; } catch {}
  let calling = false;
  let listening = false;
  let rec = null;
  let silent = 0;
  let status = '';
  let error = '';
  const emit = () => onState({ listening, calling, readAloud, status, error });
  const set = (patch) => { ({ status = status, error = error } = { status, error, ...patch }); emit(); };

  const pickVoice = () => {
    const voices = synth?.getVoices?.() ?? [];
    const lang = (globalThis.navigator?.language ?? 'en-US').toLowerCase();
    const mine = voices.filter((v) => v.lang?.toLowerCase().startsWith(lang.slice(0, 2)));
    // A voice stored on this device keeps working with no connection.
    return mine.find((v) => v.localService) ?? mine[0] ?? null;
  };

  /** Says a reply out loud; resolves when it has finished (or was cancelled). */
  function speak(bubbles) {
    const script = bubblesToSpeech(bubbles);
    if (!synth || !script) return Promise.resolve();
    synth.cancel();
    const voice = pickVoice();
    return new Promise((resolve) => {
      const chunks = speechChunks(script);
      let i = 0;
      const next = () => {
        if (i >= chunks.length || (!calling && !readAloud)) return resolve();
        const u = new SpeechSynthesisUtterance(chunks[i++]);
        if (voice) { u.voice = voice; u.lang = voice.lang; }
        u.onend = next;
        u.onerror = () => resolve();
        synth.speak(u);
      };
      next();
    });
  }

  function stopListening() {
    listening = false;
    try { rec?.abort(); } catch {}
    rec = null;
  }

  /** Listens for one utterance. mode "dictate" fills the message box; "call" sends it straight away. */
  function listen(mode) {
    if (!SR) return set({ error: 'This browser can\'t listen. Try Safari, Edge or Chrome, or type.' });
    stopListening();
    synth?.cancel();
    rec = new SR();
    rec.lang = globalThis.navigator?.language ?? 'en-US';
    rec.interimResults = true;
    rec.continuous = false;
    let heard = '';
    rec.onresult = (e) => {
      heard = [...e.results].map((r) => r[0].transcript).join(' ').trim();
      if (mode === 'dictate') fill(heard);
      else set({ status: `“${heard}”` });
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      listening = false;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') endCall('Microphone blocked. Allow it for this site to talk.');
      else if (e.error === 'network') endCall('Listening needs a connection in this browser (Chrome sends speech to a server). Typing and replies read aloud still work offline; Safari or Edge can listen offline.');
      else endCall(`Couldn't listen (${e.error}).`);
    };
    rec.onend = () => {
      listening = false;
      if (mode === 'dictate') return set({ status: '' });
      if (!calling) return;
      if (!heard) {
        silent += 1;
        if (silent >= MAX_SILENT_ROUNDS) return endCall("I didn't hear anything, so I ended the call.");
        return listen('call');
      }
      silent = 0;
      if (isGoodbye(heard)) return endCall('Call ended. Talk soon.');
      if (isBusy()) return;
      set({ status: 'Thinking…' });
      send(heard);
    };
    try {
      rec.start();
      listening = true;
      set({ error: '', status: calling ? 'Listening…' : 'Listening… tap Talk again to stop.' });
    } catch {
      listening = false;
      set({ error: "Couldn't start the microphone." });
    }
  }

  function endCall(message = '') {
    calling = false;
    silent = 0;
    stopListening();
    synth?.cancel();
    set({ status: message && !/^Couldn't|blocked|needs a connection/.test(message) ? message : '', error: /^Couldn't|blocked|needs a connection/.test(message) ? message : '' });
  }

  return {
    /** Tap once to dictate a message, again to stop. */
    toggleDictation() { if (listening && !calling) { stopListening(); return set({ status: '' }); } if (calling) return; listen('dictate'); },
    toggleReadAloud() {
      readAloud = !readAloud;
      try { storage?.setItem('pitchside.readAloud', readAloud ? '1' : '0'); } catch {}
      if (!readAloud && !calling) synth?.cancel();
      emit();
    },
    /** A hands-free call: listen, send, speak the reply, listen again, until you say goodbye or tap End. */
    toggleCall() {
      if (calling) return endCall('Call ended.');
      if (!SR) return set({ error: 'Calling needs speech recognition, which this browser lacks. Try Safari, Edge or Chrome.' });
      calling = true;
      silent = 0;
      emit();
      speak([{ type: 'text', text: 'Hi, Pitchside here. What is on your mind?' }]).then(() => calling && listen('call'));
    },
    /** Called with each reply's bubbles: reads them aloud when asked or on a call, then keeps the call going. */
    async onReply(bubbles) {
      if (!calling && !readAloud) return;
      set({ status: calling ? 'Speaking…' : '' });
      await speak(bubbles);
      if (calling) listen('call');
      else set({ status: '' });
    },
    /** A failed reply on a call: say so and keep listening. */
    onFailure(message) {
      if (!calling) return;
      speak([{ type: 'text', text: message }]).then(() => calling && listen('call'));
    },
    get state() { return { listening, calling, readAloud, status, error }; },
  };
}
