const MAX_TEXT_LENGTH = 240;

/**
 * An optional, local-device voice adapter. The caller supplies the host and owns
 * the mute/consent policy; constructing this adapter never reads browser APIs.
 * Voice discovery is on demand, with no remote fallback, timers, or voice queue.
 */
export function createLocalSpeechAdapter(host) {
  let current = null;

  function localProvider() {
    try {
      const synthesis = host?.speechSynthesis;
      if (!synthesis || typeof synthesis.getVoices !== 'function'
          || typeof synthesis.speak !== 'function' || typeof synthesis.cancel !== 'function') return null;
      const Utterance = host?.SpeechSynthesisUtterance;
      if (typeof Utterance !== 'function') return null;
      const voices = synthesis.getVoices();
      if (!Array.isArray(voices)) return null;

      let selected = null;
      let bestScore = -1;
      for (const voice of voices) {
        if (voice?.localService !== true) continue;
        const english = typeof voice.lang === 'string' && /^en(?:[-_]|$)/i.test(voice.lang);
        const score = (english ? 2 : 0) + (voice.default === true ? 1 : 0);
        if (score > bestScore) {
          selected = voice;
          bestScore = score;
        }
      }
      return selected ? { synthesis, Utterance, voice: selected } : null;
    } catch {
      // Some browsers expose the API but deny access to its voice service.
      return null;
    }
  }

  function detach(record) {
    try { record.utterance.onend = null; } catch { /* A stale callback is also identity-guarded. */ }
    try { record.utterance.onerror = null; } catch { /* A stale callback is also identity-guarded. */ }
  }

  function release(record, outcome) {
    if (current !== record || record.outcome !== null) return false;
    current = null;
    record.outcome = outcome;
    detach(record);
    return true;
  }

  function notify(callback, event) {
    if (typeof callback !== 'function') return;
    try { callback(event); } catch { /* Optional speech must not interrupt the game loop. */ }
  }

  function cancel() {
    const record = current;
    if (!record) return false;
    if (record.outcome === null) record.outcome = 'cancelled';
    detach(record);
    try { record.utterance.volume = 0; } catch { /* Cancellation remains the primary stop operation. */ }
    // Web Speech only has a global cancel operation. Never call it when this
    // adapter does not own an utterance, or an unrelated speaker could be cut off.
    try {
      record.synthesis.cancel();
      if (current === record) current = null;
      return true;
    } catch {
      // Keep one detached record for a later retry. Do not queue more speech
      // while the service has failed to confirm cancellation of this utterance.
      return false;
    }
  }

  function speak(request) {
    const text = typeof request?.text === 'string' ? request.text.trim() : '';
    const volume = request?.volume;
    if (!text || text.length > MAX_TEXT_LENGTH || !Number.isFinite(volume) || volume <= 0) return false;

    const provider = localProvider();
    if (!provider) return false;
    let utterance;
    try {
      utterance = new provider.Utterance(text);
      utterance.voice = provider.voice;
      utterance.lang = provider.voice.lang;
      utterance.volume = Math.min(1, volume);
    } catch {
      return false;
    }

    const record = { utterance, synthesis: provider.synthesis, outcome: null };
    try {
      utterance.onend = event => {
        if (release(record, 'ended')) notify(request.onend, event);
      };
      utterance.onerror = event => {
        if (release(record, 'error')) notify(request.onerror, event);
      };
    } catch {
      detach(record);
      return false;
    }

    if (current && !cancel()) {
      detach(record);
      return false;
    }
    current = record;
    try {
      provider.synthesis.speak(utterance);
      return record.outcome !== 'error';
    } catch (error) {
      if (current === record && record.outcome === null) {
        record.outcome = 'error';
        // A service may throw after accepting work. Cancel it before invoking a
        // callback that could schedule a newer utterance.
        cancel();
        notify(request.onerror, error);
      }
      return false;
    }
  }

  return Object.freeze({
    available: () => localProvider() !== null,
    // Safe to inspect even when mute policy forbids all browser API access.
    pending: () => current !== null,
    speak,
    cancel,
  });
}
