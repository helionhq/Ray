/*! @license
 * Portions of this file are derived from Hex (https://github.com/anomalyco/hex).
 *
 * MIT License
 *
 * Copyright (c) 2026 Christopher Langton
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
// Mirrored from src/bar/dotScope.ts for the marketing site's bar preview.
// Keep this in sync with the desktop bar; it is not a reimplementation.
/**
 * Dot scope — a faithful web port of the recording indicator in Hex
 * (anomalyco/hex, `src/dot_scope` + `rune_hud.wgsl`): a plate of dots lit by a
 * braided pair of oscilloscope traces that follow the voice, with a phosphor
 * tail, a cool processing flow, and a centre-out wipe when done.
 *
 * The simulation runs at a fixed 240 Hz so any refresh rate draws the same
 * picture. Coordinates are Hex's native points (a 112 × 26 plate, 43 × 9 dots
 * at 2.6 pt pitch); the canvas draws them one-to-one in CSS pixels.
 */

const PLATE_H = 26;
const RECORDING_W = 112;
const PROCESSING_W = 76;
const COLUMNS = 43;
const ROWS = 9;
const PITCH = 2.6;
const HELIX_CYCLES = 1.6;
const HISTORY_SPEED = 150;
const PHOSPHOR_TAIL = 0.6;
const PHOSPHOR_HEAD = 0.15;
const TRANSITION = 0.3;
const BOUNCE = 0.15;
const WORK_HELIX = 2.6;
const FLOW_SPACING = 0.7;
const SHIMMER_PASS = 0.55;
const ENTER = 0.42;
const WIPE = 0.3;
const HISTORY = 512;
const STEP = 1 / 240;
const SUB = 3;
const SAMPLES = (COLUMNS - 1) * SUB + 1;
/** Hex: done shows for a third of its 0.3 s wipe, then collapses. */
const COMPLETED_VISIBLE = 0.1;
/** Hex: a failure holds its still look for 0.6 s before fading out. */
const FAILED_VISIBLE = 0.6;
/** Hex's opacity-only fade when Reduce Motion is on. */
const REDUCED_FADE = 0.16;
/** The plate is drawn at Hex's native size: 112 × 26 pt. */
const DRAW_SCALE = 1;

const SPEEDS = [0.8, 1.25, 1.85, 2.6];
const BASE = [0.55, 0.42, 0.3, 0.2];
const SPATIAL = [1.4, 2.4, 3.8, 5.6];

export type BarPhase = "recording" | "processing" | "done" | "error" | "hidden";

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mix3(a: number[], b: number[], t: number): [number, number, number] {
  return [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)];
}

function passPosition(p: number) {
  return 0.5 - 0.5 * Math.cos(Math.PI * clamp(p));
}

function hermite(start: number, speed: number, end: number, t: number) {
  const u = clamp(t);
  const u2 = u * u;
  const u3 = u2 * u;
  return (
    (2 * u3 - 3 * u2 + 1) * start +
    (u3 - 2 * u2 + u) * WIPE * speed +
    (3 * u2 - 2 * u3) * end
  );
}

function roundedBox(x: number, y: number, halfW: number, halfH: number, radius: number) {
  const qx = Math.abs(x) - halfW + radius;
  const qy = Math.abs(y) - halfH + radius;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    radius
  );
}

/**
 * SwiftUI's duration + bounce spring, solved in closed form as Hex does
 * (`src/spring.rs`), so the trajectory does not depend on frame pacing.
 */
class Spring {
  value: number;
  velocity = 0;

  constructor(value: number) {
    this.value = value;
  }

  jump(value: number) {
    this.value = value;
    this.velocity = 0;
  }

  stepTo(target: number, duration: number, bounce: number, dt: number) {
    if (dt <= 0 || !Number.isFinite(dt)) return;
    const omega = (2 * Math.PI) / Math.max(duration, 0.01);
    const zeta = bounce >= 0 ? Math.max(0, 1 - bounce) : 1 / Math.max(0.01, 1 + bounce);
    const x0 = this.value - target;
    const v0 = this.velocity;

    if (zeta < 1 - 1e-4) {
      const decay = zeta * omega;
      const omegaD = omega * Math.sqrt(1 - zeta * zeta);
      const exp = Math.exp(-decay * dt);
      const sin = Math.sin(omegaD * dt);
      const cos = Math.cos(omegaD * dt);
      const sinOverD = sin / omegaD;
      this.value = target + exp * (x0 * (cos + decay * sinOverD) + v0 * sinOverD);
      this.velocity =
        exp * (-x0 * omega * omega * sinOverD + v0 * (cos - decay * sinOverD));
    } else if (zeta > 1 + 1e-4) {
      const root = Math.sqrt(zeta * zeta - 1);
      const rootSum = zeta + root;
      const slowRoot = -omega / rootSum;
      const fastRoot = -omega * rootSum;
      const denom = slowRoot - fastRoot;
      const slowExp = Math.exp(slowRoot * dt);
      const fastExp = Math.exp(fastRoot * dt);
      const p00 = (-fastRoot * slowExp + slowRoot * fastExp) / denom;
      const p01 = (slowExp - fastExp) / denom;
      const p10 = (slowRoot * fastRoot * (fastExp - slowExp)) / denom;
      const p11 = (slowRoot * slowExp - fastRoot * fastExp) / denom;
      this.value = target + p00 * x0 + p01 * v0;
      this.velocity = p10 * x0 + p11 * v0;
    } else {
      const exp = Math.exp(-omega * dt);
      const c = v0 + omega * x0;
      this.value = target + (x0 + c * dt) * exp;
      this.velocity = (v0 - omega * c * dt) * exp;
    }
  }
}

class Voice {
  level = 0;
  reservoir = 0;
  energy = 0;
  kick = 0;
  kickVelocity = 0;
  band = 0;

  step(raw: number, h: number) {
    const previous = this.level;
    const time = raw > this.level ? 0.035 : 0.095;
    this.level += (raw - this.level) * (1 - Math.exp(-h / time));
    const rise = Math.max(0, (this.level - previous) / h);
    this.reservoir += (1.75 * this.level * this.level - this.reservoir / 1.8) * h;
    this.energy = 1 - Math.exp(-this.reservoir * 1.45);
    const w = 2 * Math.PI * 1.3;
    const z = 0.22;
    this.kickVelocity +=
      (-w * w * this.kick - 2 * z * w * this.kickVelocity + 15 * rise + 2.2 * this.level) *
      h;
    this.kick += this.kickVelocity * h;
    const bandTime = raw > this.band ? 0.025 : 0.14;
    this.band += (raw - this.band) * (1 - Math.exp(-h / bandTime));
  }
}

class Trace {
  envelope = 0;
  amplitude = 0;
  amplitudeVelocity = 0;
  glowFast = 0;
  glowSpring = 0;
  glowSpringVelocity = 0;
  glowSlow = 0;
  glow = 0;
  phases: number[];
  history = new Float32Array(HISTORY * 5);
  head = 0;

  constructor(phases: number[]) {
    this.phases = phases;
  }

  step(voice: Voice, live: number, speed: number, h: number) {
    const follow = (current: number, target: number, rise: number, fall: number) => {
      const time = target > current ? rise : fall;
      return current + (target - current) * (1 - Math.exp(-h / time));
    };
    this.envelope = follow(this.envelope, voice.level, 0.022, 0.15);
    const w = 2 * Math.PI * 6.5;
    const z = 0.52;
    this.amplitudeVelocity +=
      (-w * w * (this.amplitude - this.envelope) - 2 * z * w * this.amplitudeVelocity) * h;
    this.amplitude += this.amplitudeVelocity * h;

    this.glowFast = follow(this.glowFast, voice.level, 0.045, 0.13);
    const gw = 2 * Math.PI * 3.6;
    const gz = 0.5;
    this.glowSpringVelocity +=
      (-gw * gw * (this.glowSpring - this.glowFast) -
        2 * gz * gw * this.glowSpringVelocity) *
      h;
    this.glowSpring += this.glowSpringVelocity * h;
    this.glowSlow = follow(this.glowSlow, voice.level, 0.15, 0.7);

    const swell =
      0.8 * Math.max(0, this.glowSpring - 0.25) + 0.04 * Math.max(-0.5, voice.kick);
    this.glow = (Math.max(0, swell) + 0.42 * this.glowSlow + 0.2 * voice.energy) * live;
    this.glow = Math.min(this.glow, 1.15);

    const go = 0.6 + 1.1 * Math.min(1, this.envelope * 1.6);
    for (let index = 0; index < this.phases.length; index += 1) {
      this.phases[index] =
        (this.phases[index] + h * 2 * Math.PI * SPEEDS[index] * go * speed) %
        (2 * Math.PI);
    }

    const emphasis = 0.35 + 0.65 * Math.min(2, voice.band / (voice.band + 0.06));
    const offset = this.head * 5;
    const amplitude = Math.max(0, this.amplitude) * live;
    this.history[offset] = amplitude;
    for (let channel = 0; channel < BASE.length; channel += 1) {
      this.history[offset + 1 + channel] = amplitude * BASE[channel] * emphasis;
    }
    this.head = (this.head + 1) % HISTORY;
  }

  past(delay: number, channel: number) {
    const d = Math.min(delay / STEP, HISTORY - 2);
    const index = Math.floor(d);
    const k = d - index;
    const a = (this.head + 2 * HISTORY - 1 - index) % HISTORY;
    const b = (a + HISTORY - 1) % HISTORY;
    return this.history[a * 5 + channel] * (1 - k) + this.history[b * 5 + channel] * k;
  }
}

interface Palette {
  base: [number, number, number];
  core: [number, number, number];
  plate: [number, number, number, number];
  rim: [number, number, number, number];
}

function palette(dark: boolean, cool: number, fail: number): Palette {
  const you = dark ? [0.86, 0.83, 0.77] : [0.62, 0.53, 0.4];
  const youCore = dark ? [0.98, 0.96, 0.92] : [0.47, 0.38, 0.26];
  const agent = dark ? [0.7, 0.78, 0.9] : [0.4, 0.47, 0.58];
  const agentCore = dark ? [0.92, 0.95, 1] : [0.24, 0.31, 0.43];
  const coral = dark ? [1, 0.38, 0.31] : [0.9, 0.27, 0.21];
  const coralCore = dark ? [1, 0.66, 0.6] : [0.7, 0.18, 0.13];
  const base = mix3(mix3(you, agent, cool), coral, fail);
  const core = mix3(mix3(youCore, agentCore, cool), coralCore, fail);
  return {
    base,
    core,
    plate: dark ? [17 / 255, 17 / 255, 20 / 255, 0.94] : [252 / 255, 251 / 255, 249 / 255, 0.96],
    rim: dark ? [1, 1, 1, 0.11] : [0, 0, 0, 0.09],
  };
}

export class DotScope {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private widthPx = 304;
  private heightPx = 80;

  private phase: BarPhase = "hidden";
  private elapsed = 0;
  private time = 0;
  private visible = false;
  private settled = true;
  private pending = 0;
  private levelInput = 0;
  private autoPeak = 0.4;

  private voices = [new Voice(), new Voice()];
  private traces = [new Trace([0.1, 1.7, 3.3, 4.6]), new Trace([2.4, 0.6, 5.1, 1.9])];
  private live = 0;
  private carrier = 0;
  private flowOffset = 0;
  private flowTurn = 0;
  private grid = 0;
  private speedAtDone = 0;
  private widthTarget = RECORDING_W;
  private steps = 0;
  private frozen = false;

  private width = new Spring(30);
  private opacity = new Spring(0);
  private scale = new Spring(0.9);
  private softness = new Spring(3);
  private cool = new Spring(0);
  private fail = new Spring(0);

  private ys: Float32Array[] = [new Float32Array(SAMPLES), new Float32Array(SAMPLES)];
  private brightness: Float32Array[] = [
    new Float32Array(SAMPLES),
    new Float32Array(SAMPLES),
  ];
  private head: Float32Array[] = [
    new Float32Array(COLUMNS * ROWS),
    new Float32Array(COLUMNS * ROWS),
  ];
  private tail: Float32Array[] = [
    new Float32Array(COLUMNS * ROWS),
    new Float32Array(COLUMNS * ROWS),
  ];
  private power = new Float32Array(COLUMNS * ROWS);
  private fresh = new Float32Array(COLUMNS * ROWS);

  private raf = 0;
  private last = 0;
  /** Offscreen layer for the entrance's soft-focus pass (see `draw`). */
  private layer: HTMLCanvasElement;
  private layerCtx: CanvasRenderingContext2D;
  private dark = false;
  private reduceMotion = false;
  private media: MediaQueryList;
  private motion: MediaQueryList;
  private observer: ResizeObserver;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) throw new Error("Canvas is unavailable");
    this.ctx = context;
    const layer = document.createElement("canvas");
    const layerContext = layer.getContext("2d", { alpha: true });
    if (!layerContext) throw new Error("Canvas is unavailable");
    this.layer = layer;
    this.layerCtx = layerContext;
    this.media = window.matchMedia("(prefers-color-scheme: dark)");
    this.motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const forced = new URLSearchParams(window.location.search).get("theme");
    this.dark = forced ? forced === "dark" : this.media.matches;
    this.reduceMotion = this.motion.matches;
    this.media.addEventListener("change", this.onTheme);
    this.motion.addEventListener("change", this.onMotion);
    window.addEventListener("resize", this.resize);
    // CSS/DPI can settle after the canvas first mounts (and a hidden window
    // can report a different content box); keep the backing store in step.
    this.observer = new ResizeObserver(this.resize);
    this.observer.observe(canvas);
    this.resize();
    this.last = performance.now();
    this.wake();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.media.removeEventListener("change", this.onTheme);
    this.motion.removeEventListener("change", this.onMotion);
    window.removeEventListener("resize", this.resize);
    this.observer.disconnect();
  }

  setLevel(level: number) {
    this.levelInput = clamp(level);
    if (this.phase === "recording") this.wake();
  }

  /** Browser QA: run `seconds` of simulation synchronously and paint once. */
  preview(phase: BarPhase, seconds = 1.6, level?: (time: number) => number) {
    this.setPhase(phase);
    this.frozen = true;
    const steps = Math.round(seconds / STEP);
    for (let k = 0; k < steps; k += 1) {
      if (level && phase === "recording") this.levelInput = level(k * STEP);
      this.step(STEP);
    }
    this.draw();
  }

  setPhase(phase: BarPhase) {
    if (phase === this.phase) return;
    this.phase = phase;
    this.elapsed = 0;
    this.settled = false;
    if (phase === "recording") {
      this.reset();
      this.visible = true;
    } else if (phase === "hidden") {
      this.visible = false;
    } else {
      this.visible = true;
      if (phase === "processing") {
        this.flowOffset = -this.width.value / 2 - 4;
      }
      if (phase === "done") {
        this.armDone();
      }
    }
    this.wake();
  }

  private reset() {
    this.elapsed = 0;
    this.voices = [new Voice(), new Voice()];
    this.traces = [new Trace([0.1, 1.7, 3.3, 4.6]), new Trace([2.4, 0.6, 5.1, 1.9])];
    this.live = 0;
    this.carrier = 0;
    this.flowOffset = 0;
    this.flowTurn = 0;
    this.grid = 0;
    this.widthTarget = RECORDING_W;
    this.width.jump(30);
    this.opacity.jump(0);
    this.scale.jump(0.9);
    this.softness.jump(3);
    this.cool.jump(0);
    this.fail.jump(0);
    this.power.fill(0);
    this.fresh.fill(0);
    for (const buffer of this.head) buffer.fill(0);
    for (const buffer of this.tail) buffer.fill(0);
  }

  private workPeriod() {
    return 2 * SHIMMER_PASS;
  }

  private pulseSpeed() {
    return (PROCESSING_W / 2 + 12) / (1.4 * this.workPeriod());
  }

  private flowSpacing() {
    return FLOW_SPACING * PROCESSING_W;
  }

  private flowSpeed() {
    return this.flowSpacing() / this.workPeriod();
  }

  private flowTurnHz() {
    return (this.flowSpeed() * HELIX_CYCLES) / Math.max(1, this.width.value);
  }

  private armDone() {
    this.speedAtDone = 1.5 * this.pulseSpeed();
  }

  private workingLight(x: number, _halfWidth: number) {
    const spacing = this.flowSpacing();
    const d = (((x - this.flowOffset + spacing / 2) % spacing) + spacing) % spacing - spacing / 2;
    return Math.exp(-((d / 7) ** 2));
  }

  private scanAt(x: number): [number, number, number] {
    const width = Math.max(this.width.value, PLATE_H);
    const halfWidth = width / 2;
    const e = this.elapsed;

    if (this.phase === "error" || this.reduceMotion) {
      return [1, 1, 0];
    }

    if (this.phase === "recording") {
      const reach = (width / 2 + 12) * passPosition(e / ENTER);
      const d = Math.abs(x);
      const unfold = smoothstep(0, 0.1, e);
      const drawn = unfold * (1 - smoothstep(Math.max(0, reach - 14), Math.max(0.001, reach), d));
      const amplitude =
        drawn *
        (1 - smoothstep(Math.max(0, reach - 22), Math.max(0.001, reach - 3), d));
      const head = 2.8 * (1 - smoothstep(0.08, ENTER, e));
      const beam = head * Math.exp(-(((d - reach) / 6) ** 2));
      const swell =
        1.8 * unfold * (head / 2.8) * Math.exp(-(((d - Math.max(0, reach - 14)) / 14) ** 2));
      return [amplitude, amplitude + beam, swell];
    }

    if (this.phase === "processing") {
      const enter = smoothstep(0, 0.35, e);
      const light = this.workingLight(x, halfWidth);
      const head = 2.5 * smoothstep(0.05, 0.3, e);
      return [1, 1 + head * light, 0.9 * enter * light];
    }

    if (this.phase === "done") {
      const front = hermite(0, this.speedAtDone, width / 2 + 8, e / WIPE);
      const d = Math.abs(x);
      const keep = smoothstep(front - 12, front - 2, d);
      const light = this.workingLight(x, halfWidth);
      const head = 2.8 * smoothstep(0, 0.04, e) * (1 - smoothstep(0.22, 0.32, e));
      const glow = 2.5 * (1 - smoothstep(0, 0.18, e));
      return [
        keep,
        keep * (1 + glow * light) + head * Math.exp(-(((d - front) / 6) ** 2)),
        keep * 0.9 * light,
      ];
    }

    return [0, 0, 0];
  }

  private step(h: number) {
    this.elapsed += h;
    this.time += h;
    const visible = this.visible;
    const recording = this.phase === "recording" && visible;

    let level = 0;
    if (recording) {
      const raw = clamp(this.levelInput * 1.12);
      this.autoPeak = Math.max(raw, this.autoPeak * Math.exp(-h / 3));
      const adaptive = raw / Math.max(0.32, this.autoPeak * 0.9);
      level = clamp(Math.max(raw * 0.55, adaptive * 0.9));
      if (raw < 0.025) level = 0;
    }
    this.voices[0].step(level, h);
    this.voices[1].step(level * 0.85, h);
    const liveTarget = recording ? 1 : 0;
    this.live += (liveTarget - this.live) * (1 - Math.exp(-h / 0.55));

    const speed = this.reduceMotion ? 0 : 1;
    for (let index = 0; index < 2; index += 1) {
      this.traces[index].step(this.voices[index], this.live, speed, h);
    }

    const energy = Math.max(this.voices[0].energy, this.voices[1].energy);
    const working = this.phase === "processing" || this.phase === "done";
    const flowing = working;
    this.flowTurn += ((flowing ? 1 : 0) - this.flowTurn) * (1 - Math.exp(-h / 0.25));
    if (working) this.flowOffset += this.flowSpeed() * h;

    const rest = 0.14 + 0.22 * energy;
    const turn = rest + (this.flowTurnHz() - rest) * this.flowTurn;
    this.carrier = (this.carrier + h * 2 * Math.PI * turn * speed) % (2 * Math.PI);

    if (this.phase === "recording") this.widthTarget = RECORDING_W;
    if (this.phase === "processing" || this.phase === "done") {
      this.widthTarget = PROCESSING_W;
    }
    const targetWidth = this.widthTarget;
    const targetCool = this.phase === "processing" || this.phase === "done" ? 1 : 0;
    const targetFail = this.phase === "error" ? 1 : 0;
    const shown = visible ? 1 : 0;

    if (this.reduceMotion) {
      // Hex stills the shape and keeps only a short opacity fade.
      this.width.jump(targetWidth);
      this.scale.jump(1);
      this.softness.jump(0);
      this.opacity.stepTo(shown, REDUCED_FADE, 0, h);
      this.cool.stepTo(targetCool, REDUCED_FADE, 0, h);
      this.fail.stepTo(targetFail, REDUCED_FADE, 0, h);
    } else {
      this.width.stepTo(targetWidth, TRANSITION, BOUNCE, h);
      this.opacity.stepTo(shown, TRANSITION, 0, h);
      this.scale.stepTo(visible ? 1 : 0.9, TRANSITION, BOUNCE, h);
      this.softness.stepTo(visible ? 0 : 3, TRANSITION, 0, h);
      this.cool.stepTo(targetCool, TRANSITION, 0, h);
      this.fail.stepTo(targetFail, TRANSITION, 0, h);
    }

    // Done shows its wipe, then collapses into the hide; a failure holds
    // its still look for 0.6 s first. Both then fade over the transition.
    if (this.phase === "done" && this.elapsed >= COMPLETED_VISIBLE && !this.frozen) {
      this.visible = false;
    }
    if (this.phase === "error" && this.elapsed >= FAILED_VISIBLE && !this.frozen) {
      this.visible = false;
    }

    this.steps += 1;
    if (this.steps % 2 === 0) {
      this.beam(2 * h);
    }
  }

  private beam(hb: number) {
    const width = Math.max(this.width.value, PLATE_H);
    const halfWidth = width / 2;
    const mid = (ROWS - 1) / 2;
    const half = mid - 0.55;
    const breath = this.reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin((this.time * 2 * Math.PI) / 5.5);
    const still = this.phase === "error" || this.reduceMotion;
    const helix = still
      ? 1
      : this.phase === "done"
        ? WORK_HELIX
        : this.phase === "processing"
          ? 1 + (WORK_HELIX - 1) * smoothstep(0, 0.35, this.elapsed)
          : 1;
    const rest = (0.55 + 0.35 * breath) * (0.4 + 0.6 * this.live) * helix;
    const gridFade = still
      ? 1
      : this.phase === "done"
        ? 1 - smoothstep(0.2, 0.4, this.elapsed)
        : this.phase === "recording"
          ? Math.min(1, this.elapsed / 0.3)
          : 1;
    this.grid = gridFade;

    for (let k = 0; k < 2; k += 1) {
      const trace = this.traces[k];
      const sign = k === 0 ? 1 : -1;
      const ys = this.ys[k];
      const brightness = this.brightness[k];
      for (let s = 0; s < SAMPLES; s += 1) {
        const x = (s / SUB - (COLUMNS - 1) / 2) * PITCH;
        if (Math.abs(x) > halfWidth) {
          ys[s] = mid;
          brightness[s] = 0;
          continue;
        }
        const [amplitude, bright, swell] = this.scanAt(x);
        const own = Math.abs(x);
        const xn = (x + halfWidth) / width;
        const ends = Math.min(
          smoothstep(-halfWidth + 3, -halfWidth + 17, x),
          smoothstep(-halfWidth + 3, -halfWidth + 17, -x),
        );
        const reach = 1 - 0.8 * smoothstep(14, halfWidth, own);
        const delay = own / HISTORY_SPEED;
        const a = trace.past(delay, 0);
        let spread = 0;
        for (let c = 0; c < SPATIAL.length; c += 1) {
          spread +=
            trace.past(delay, 1 + c) *
            Math.sin(2 * Math.PI * SPATIAL[c] * xn - trace.phases[c]);
        }
        const wave =
          (rest + swell + half * 0.55 * a * reach) *
          Math.sin(2 * Math.PI * HELIX_CYCLES * xn - this.carrier);
        const y = half * Math.tanh((wave + half * 0.7 * spread * reach) / half) * ends * amplitude;
        ys[s] = mid - sign * y;
        const spatial = (0.3 + 0.7 * Math.min(1, a * 1.8)) * (0.45 + 0.55 * ends);
        brightness[s] = spatial * amplitude + 0.36 * Math.max(0, bright - amplitude);
      }
      for (let s = 0; s < SAMPLES; s += 1) {
        const slope =
          ((ys[Math.min(SAMPLES - 1, s + 1)] - ys[Math.max(0, s - 1)]) * SUB) / 2;
        brightness[s] *= 1 - 0.55 + 0.55 / Math.sqrt(1 + 0.22 * slope * slope);
      }
    }

    // Hex's done scan decays the phosphor head and tail as the field clears.
    const done = this.phase === "done";
    const decay = done ? 1 - 0.6 * smoothstep(0, 0.12, this.elapsed) : 1;
    const tailFade = done ? 1 - smoothstep(0, 0.15, this.elapsed) : 1;
    const headKeep = Math.exp(-hb / (PHOSPHOR_HEAD * decay));
    const tailKeep = Math.exp(-hb / (PHOSPHOR_TAIL * decay));
    const dx = 1 / SUB;
    for (let i = 0; i < COLUMNS; i += 1) {
      const s0 = Math.max(0, (i - 3) * SUB);
      const s1 = Math.min(SAMPLES - 1, (i + 3) * SUB);
      for (let j = 0; j < ROWS; j += 1) {
        const n = j * COLUMNS + i;
        let now = 0;
        let total = 0;
        const lit = [0, 0];
        for (let k = 0; k < 2; k += 1) {
          const ys = this.ys[k];
          let best = Number.POSITIVE_INFINITY;
          let nearest = i * SUB;
          for (let s = s0; s < s1; s += 1) {
            const ay = ys[s];
            const dy = ys[s + 1] - ay;
            const px = i - s * dx;
            const py = j - ay;
            const t = clamp((px * dx + py * dy) / (dx * dx + dy * dy || 1e-6));
            const ex = px - t * dx;
            const ey = py - t * dy;
            const d2 = ex * ex + ey * ey;
            if (d2 < best) {
              best = d2;
              nearest = s;
            }
          }
          const value = this.brightness[k][nearest];
          const onBeam = Math.exp(-best / 0.25);
          const instant = Math.min(1.2, (onBeam + 0.5 * Math.exp(-Math.sqrt(best) / 0.8)) * value);
          const core = onBeam * value;
          this.head[k][n] = Math.max(this.head[k][n] * headKeep, core);
          this.tail[k][n] = Math.max(this.tail[k][n] * tailKeep, core);
          const light = Math.max(
            instant,
            this.head[k][n],
            0.55 * tailFade * this.tail[k][n],
          );
          lit[k] = light;
          now += instant;
          total += light;
        }
        const power = 1 - (1 - Math.min(1, lit[0])) * (1 - Math.min(1, lit[1]));
        this.power[n] = clamp(power);
        this.fresh[n] = clamp(now / Math.max(1e-4, total));
      }
    }
  }

  private onTheme = () => {
    const forced = new URLSearchParams(window.location.search).get("theme");
    this.dark = forced ? forced === "dark" : this.media.matches;
    this.settled = false;
    this.wake();
  };

  private onMotion = () => {
    this.reduceMotion = this.motion.matches;
    this.settled = false;
    this.wake();
  };

  private resize = () => {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    // A hidden window can report a zero content box; keep the last good one.
    if (rect.width > 0) this.widthPx = rect.width;
    if (rect.height > 0) this.heightPx = rect.height;
    const width = Math.round(this.widthPx * this.dpr);
    const height = Math.round(this.heightPx * this.dpr);
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    if (this.layer.width !== width) this.layer.width = width;
    if (this.layer.height !== height) this.layer.height = height;
    this.settled = false;
    this.wake();
  };

  private frame = (now: number) => {
    this.raf = 0;
    const dt = Math.max(0, Math.min(0.05, (now - this.last) / 1000 || 0));
    this.last = now;
    const running = !this.settled || this.visible;
    if (running) {
      this.pending += dt;
      while (this.pending >= STEP) {
        this.pending -= STEP;
        this.step(STEP);
      }
      this.draw();
      if (!this.visible && this.opacity.value < 0.002 && this.phase !== "recording") {
        this.settled = true;
      }
    }
    if (!this.settled || this.visible) {
      this.raf = requestAnimationFrame(this.frame);
    }
  };

  /**
   * Restarts the loop after it has settled. The bar is hidden most of the
   * time; leaving a 60 Hz callback running then is pure battery cost. Resetting
   * `last` keeps the first frame's dt honest instead of clamping a long idle
   * gap to 50 ms, which would skip the start of the entrance.
   */
  private wake() {
    if (this.raf === 0) {
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
    }
  }

  private draw() {
    const ctx = this.ctx;
    const w = this.widthPx;
    const h = this.heightPx;
    this.mapToPixels();
    ctx.clearRect(0, 0, w, h);
    const poseWidth = Math.max(this.width.value, PLATE_H);
    const scale = DRAW_SCALE * Math.max(0.01, this.scale.value);
    const halfW = (poseWidth * scale) / 2;
    const halfH = (PLATE_H * scale) / 2;
    const radius = halfH;
    const dark = this.dark;
    const colors = palette(dark, this.cool.value, this.fail.value);
    const opacity = clamp(this.opacity.value);

    if (opacity <= 0.002) return;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(w / 2, h / 2);

    // Plate with Hex's drop shadow: a soft falloff 3 pt below the plate,
    // matching rune_hud.wgsl's `0.5 - 0.5 * tanh(distance / 6.5)` field
    // (a ~5.2 pt Gaussian, i.e. canvas blur ~10.4).
    ctx.beginPath();
    ctx.roundRect(-halfW, -halfH, halfW * 2, halfH * 2, radius);
    ctx.save();
    ctx.shadowColor = dark ? "rgba(0,0,0,0.5)" : "rgba(20,24,40,0.2)";
    ctx.shadowBlur = 10.4;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = `rgba(${Math.round(colors.plate[0] * 255)},${Math.round(
      colors.plate[1] * 255,
    )},${Math.round(colors.plate[2] * 255)},${colors.plate[3]})`;
    ctx.fill();
    ctx.restore();

    // Hex's rim is `abs(distance) - 0.3`: a 0.6 pt line.
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = `rgba(${Math.round(colors.rim[0] * 255)},${Math.round(
      colors.rim[1] * 255,
    )},${Math.round(colors.rim[2] * 255)},${colors.rim[3]})`;
    ctx.stroke();

    ctx.save();
    ctx.beginPath();
    ctx.roundRect(-halfW, -halfH, halfW * 2, halfH * 2, radius);
    ctx.clip();

    const softness = this.softness.value;
    const blurred = softness > 0.05;
    // Chromium filters every individual canvas draw call when `filter` is
    // set, so the entrance's hundreds of dot fills would each pay a full
    // blur pass and the bar drops frames for the first half second. Compose
    // the soft-focus content once in an offscreen layer and blur that layer
    // with a single drawImage instead; the result is the same soft field.
    const paint = blurred ? this.layerCtx : ctx;
    if (paint !== ctx) {
      paint.setTransform(1, 0, 0, 1, 0, 0);
      paint.clearRect(0, 0, this.layer.width, this.layer.height);
      paint.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      paint.translate(w / 2, h / 2);
      // Same global alpha as the main canvas: the aggregate then composites
      // over the plate exactly as the per-dot draws would.
      paint.globalAlpha = opacity;
      paint.save();
      paint.beginPath();
      paint.roundRect(-halfW, -halfH, halfW * 2, halfH * 2, radius);
      paint.clip();
    }

    // Glow behind the voice.
    const glow = this.traces[0].glow / 2 + this.traces[1].glow / 2;
    if (glow > 0.01) {
      const reach = (34 + 20 * glow) * scale;
      const middle = mix3(colors.base, colors.core, 0.5);
      const strength = (dark ? 0.19 : 0.3) * 0.55 * Math.min(1, glow);
      // Hex mixes the colour from the voice toward the plate's base and
      // fades the glow linearly to the reach.
      const gradient = paint.createRadialGradient(0, 0, 0, 0, 0, reach);
      for (let stop = 0; stop <= 5; stop += 1) {
        const t = stop / 5;
        const color = mix3(middle, colors.base, t);
        gradient.addColorStop(
          t,
          `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(
            color[2] * 255,
          )},${strength * (1 - t)})`,
        );
      }
      paint.fillStyle = gradient;
      paint.fillRect(-halfW, -halfH, halfW * 2, halfH * 2);
    }

    const presence = 0.5 + 0.5 * Math.max(this.live, this.cool.value);
    const unlit = dark ? 0.085 : 0.07;
    const full = dark ? 1 : 0.96;
    const curve = dark ? 0.75 : 0.9;
    const centerX = ((COLUMNS - 1) / 2) * PITCH;
    const centerY = ((ROWS - 1) / 2) * PITCH;
    const nativeHalfW = poseWidth / 2;
    const nativeHalfH = PLATE_H / 2;
    const nativeRadius = PLATE_H / 2;

    for (let j = 0; j < ROWS; j += 1) {
      for (let i = 0; i < COLUMNS; i += 1) {
        const n = j * COLUMNS + i;
        const power = this.power[n];
        const fresh = this.fresh[n];
        const nx = i * PITCH - centerX;
        const ny = j * PITCH - centerY;
        const cap = -roundedBox(nx, ny, nativeHalfW, nativeHalfH, nativeRadius);
        const mask = smoothstep(1.4, 4.6, cap);
        if (mask <= 0.001) continue;
        const row = Math.abs(ny) / nativeHalfH;
        const floorAlpha =
          unlit * (1 - 0.7 * smoothstep(0.35, 0.95, row)) * presence * this.grid;
        const alpha =
          floorAlpha + (full - floorAlpha) * Math.pow(power, curve * mix(1.4, 1, fresh));
        if (alpha <= 0.004) continue;
        const dotRadius =
          (0.25 + 0.17 * Math.pow(power, 0.6)) *
          mix(1, mix(0.82, 1, fresh), smoothstep(0.03, 0.2, power)) *
          PITCH *
          scale;
        const core = Math.pow(power, 2) * 1.1;
        const color = mix3(colors.base, colors.core, Math.min(0.9, core) * mix(0.3, 1, fresh));
        const x = nx * scale;
        const y = ny * scale;
        if (power > 0.05) {
          paint.fillStyle = `rgba(${Math.round(color[0] * 255)},${Math.round(
            color[1] * 255,
          )},${Math.round(color[2] * 255)},${0.132 * power * power * mask})`;
          paint.beginPath();
          paint.arc(x, y, dotRadius * 2, 0, Math.PI * 2);
          paint.fill();
        }
        paint.fillStyle = `rgba(${Math.round(color[0] * 255)},${Math.round(
          color[1] * 255,
        )},${Math.round(color[2] * 255)},${alpha * mask})`;
        paint.beginPath();
        paint.arc(x, y, dotRadius, 0, Math.PI * 2);
        paint.fill();
      }
    }

    if (paint !== ctx) {
      paint.restore();
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.filter = `blur(${(softness * scale * 0.9).toFixed(2)}px)`;
      ctx.drawImage(this.layer, -w / 2, -h / 2, w, h);
      ctx.filter = "none";
      ctx.restore();
    }
    ctx.restore();
    ctx.restore();
  }

  private mapToPixels() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
}
