/** A QA/silent URL is a safety boundary, not a preference the UI can undo. */
export function createAudioPolicy({ search = '', webdriver = false } = {}) {
  const params = new URLSearchParams(search);
  const enabled = (key) => params.getAll(key).some((value) => /^(1|true)$/i.test(value));
  const hardMuted = webdriver === true || enabled('mute') || enabled('qa');
  let muted = true;

  return Object.freeze({
    hardMuted,
    isMuted: () => hardMuted || muted,
    setMuted(value) {
      muted = hardMuted || Boolean(value);
      return muted;
    },
  });
}
