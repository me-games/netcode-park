// Tiny synthesized sound effects (no asset files needed). The AudioContext is
// created lazily and resumed on the first user gesture (browsers require that).
let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  if (ctx) return ctx;
  const C = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  if (!C) return null;
  ctx = new C();
  return ctx;
}

/** Wire this to the first keydown/pointerdown so audio is allowed to play. */
export function unlockAudio() {
  const c = ac();
  if (c && c.state === "suspended") void c.resume();
}

function tone(freq: number, dur: number, type: OscillatorType, gain = 0.2, slideTo?: number) {
  const c = ac();
  if (!c || c.state !== "running") return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime);
  if (slideTo !== undefined) osc.frequency.exponentialRampToValueAtTime(slideTo, c.currentTime + dur);
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
  osc.connect(g).connect(c.destination);
  osc.start();
  osc.stop(c.currentTime + dur + 0.02);
}

export function sfxKick() {
  tone(220, 0.12, "triangle", 0.22, 90);
}
export function sfxWhistle() {
  tone(1900, 0.18, "square", 0.12);
  setTimeout(() => tone(2100, 0.22, "square", 0.12), 120);
}
export function sfxCheer() {
  tone(523, 0.14, "sine", 0.16, 660);
  setTimeout(() => tone(659, 0.16, "sine", 0.16, 784), 90);
  setTimeout(() => tone(784, 0.22, "sine", 0.16, 988), 190);
}
export function sfxThud() {
  tone(120, 0.16, "sine", 0.22, 60);
}
