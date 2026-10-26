// Короткие звуки через WebAudio — без файлов.
import { progress } from "../state/progress";

let ctx: AudioContext | null = null;

function tone(freq: number, start: number, dur: number, type: OscillatorType = "sine", vol = 0.12): void {
  if (!ctx) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.value = freq;
  const t = ctx.currentTime + start;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t);
  o.stop(t + dur + 0.05);
}

export function play(kind: "right" | "wrong" | "finish" | "tap"): void {
  if (!progress.settings.sound) return;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    return;
  }
  if (kind === "right") {
    tone(660, 0, 0.12, "triangle");
    tone(990, 0.09, 0.2, "triangle");
  } else if (kind === "wrong") {
    tone(180, 0, 0.18, "square", 0.06);
    tone(140, 0.12, 0.25, "square", 0.06);
  } else if (kind === "finish") {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.11, 0.25, "triangle"));
  } else {
    tone(880, 0, 0.04, "sine", 0.05);
  }
}
