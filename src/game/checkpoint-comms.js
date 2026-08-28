// Short, licensed tactical recordings accompany the original story captions.
// Keep their subtitles separate: these are intercepted radio voices, not an
// imitation of a film actor or a spoken version of Castle's written dialogue.
const cues = {
  apartment: ['ready', 'Ready.'],
  neighbor: ['cover-me', 'Cover me.'],
  balcony: ['get-down', 'Get down.'],
  stairwell: ['hold', 'Hold.'],
  roof: ['target-engaged', 'Target engaged.'],
  scaffolding: ['watch-my-back', 'Watch my back.'],
  street: ['go-go-go', 'Go, go, go.'],
  bakery: ['hurry-up', 'Hurry up.'],
};

export const CHECKPOINT_COMMS = Object.freeze(Object.fromEntries(
  Object.entries(cues).map(([zone, [clip, text]]) => [zone, Object.freeze({
    id: `checkpoint:${zone}`, zone, sampleId: `radio:${clip}`, text,
  })]),
));
