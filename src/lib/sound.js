/** Subtle UI sounds synthesized with WebAudio (no assets). */

let ctx = null;

function audioContext() {
  if (!ctx) {
    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function chime(notes, { gain = 0.06, duration = 0.18 } = {}) {
  const ac = audioContext();
  if (!ac) return;
  const now = ac.currentTime;
  notes.forEach((freq, i) => {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const t0 = now + i * 0.09;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
    osc.connect(g).connect(ac.destination);
    osc.start(t0);
    osc.stop(t0 + duration + 0.05);
  });
}

export const sounds = {
  join: () => chime([523.25, 659.25]), //   C5 E5
  leave: () => chime([659.25, 523.25]), //  E5 C5
  message: () => chime([880], { gain: 0.04, duration: 0.12 }),
  hand: () => chime([740], { gain: 0.04, duration: 0.15 }),
};
