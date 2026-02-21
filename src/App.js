
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Lyrics-to-Song (single-file demo)
 * - Generates rhythmic + melodic note events from pasted lyrics
 * - Plays a synthetic "singing" voice via WebAudio (oscillator + envelope + simple formant-ish filter)
 * - Optional SpeechSynthesis overlay ("karaoke style")
 * - Creates simple sheet-music-like notation via ABC string; renders with abcjs if available (loaded dynamically)
 * - Exports: JSON (project), ABC, MIDI (very simple), WAV (offline render; best-effort)
 *
 * NOTE: Browser-based "singing" is approximated. True singing/TTS models require server-side ML or specialized APIs.
 */

const VERSION = "0.9.0";
const DEFAULT_SEED = "hasei-music";
const DEFAULT_PROJECT_NAME = "MyLyricsSong";

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;

// ----- Musical helpers -----
const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 10];
const PENTATONIC_STEPS = [0, 2, 4, 7, 9];
const DORIAN_STEPS = [0, 2, 3, 5, 7, 9, 10];
const HARM_MINOR_STEPS = [0, 2, 3, 5, 7, 8, 11];

function noteNameToMidi(noteName = "C4") {
  const m = /^([A-G])(#|b)?(\d+)$/.exec(noteName.trim());
  if (!m) return 60;
  const letter = m[1];
  const accidental = m[2] || "";
  const octave = parseInt(m[3], 10);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
  let semis = base;
  if (accidental === "#") semis += 1;
  if (accidental === "b") semis -= 1;
  return 12 * (octave + 1) + semis;
}

function midiToFreq(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

function midiToNoteName(m) {
  const pc = ((m % 12) + 12) % 12;
  const oct = Math.floor(m / 12) - 1;
  return `${NOTE_NAMES_SHARP[pc]}${oct}`;
}

function pickScale(mode) {
  switch (mode) {
    case "major": return MAJOR_STEPS;
    case "minor": return MINOR_STEPS;
    case "pentatonic": return PENTATONIC_STEPS;
    case "dorian": return DORIAN_STEPS;
    case "harmonic_minor": return HARM_MINOR_STEPS;
    default: return MAJOR_STEPS;
  }
}

function hashToSeedInt(str) {
  // deterministic seed from string
  const h = cryptoSubtleHashSync(str || "");
  return h >>> 0;
}

function cryptoSubtleHashSync(str) {
  // A tiny sync fallback hash (FNV-1a style) to avoid async crypto in UI generation
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ----- Lyrics helpers (simple Japanese-friendly splitting) -----
function normalizeLyrics(text) {
  return (text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitSections(text) {
  // Blank line separates sections
  const blocks = normalizeLyrics(text).split(/\n\s*\n/).filter(Boolean);
  if (blocks.length === 0) return [{ name: "Verse", lines: [""] }];
  return blocks.map((b, idx) => ({
    name: idx === 0 ? "Verse" : `Section ${idx + 1}`,
    lines: b.split("\n").map(s => s.trim()).filter(Boolean)
  }));
}

// Very naive mora-ish splitter for Japanese: keeps small kana with previous char.
function splitToMoras(line) {
  const s = (line || "").trim();
  if (!s) return [];
  const chars = Array.from(s);
  const small = new Set(["ぁ","ぃ","ぅ","ぇ","ぉ","ゃ","ゅ","ょ","ゎ","ァ","ィ","ゥ","ェ","ォ","ャ","ュ","ョ","ヮ","っ","ッ","ゕ","ゖ","ゎ"]);
  const out = [];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (small.has(c) && out.length > 0) out[out.length - 1] += c;
    else out.push(c);
  }
  // Merge punctuation as separate tokens
  return out.filter(x => x !== " ");
}

// ----- Rhythm & melody generation -----
function generateRhythm(moraCount, meter, complexity, rnd) {
  // Returns array of durations in beats, length = moraCount (or less if rests inserted separately)
  // complexity: 0..1
  const beatsPerBar = meter === "3/4" ? 3 : 4;
  const baseGrid = complexity < 0.35 ? 1 : (complexity < 0.7 ? 0.5 : 0.25); // quarter, eighth, 16th
  const maxBeats = Math.max(beatsPerBar, Math.ceil(moraCount * baseGrid));
  let remaining = maxBeats;
  const durs = [];
  for (let i = 0; i < moraCount; i++) {
    // prefer small notes as complexity rises
    const choices = complexity < 0.35
      ? [1, 1, 2]
      : complexity < 0.7
        ? [0.5, 0.5, 1, 1.5]
        : [0.25, 0.25, 0.5, 0.75, 1];
    let d = choices[Math.floor(rnd() * choices.length)];
    // fit remaining
    d = Math.min(d, remaining);
    if (d <= 0) d = baseGrid;
    durs.push(d);
    remaining -= d;
    if (remaining <= 0 && i < moraCount - 1) {
      remaining += beatsPerBar; // continue into next bar
    }
  }
  return durs;
}

function generateContour(n, complexity, rnd) {
  // melodic contour steps: -2..+2
  const steps = [];
  let cur = 0;
  for (let i = 0; i < n; i++) {
    const jumpBias = complexity < 0.35 ? 0.6 : (complexity < 0.7 ? 0.9 : 1.2);
    let step = Math.round((rnd() - 0.5) * 4 * jumpBias);
    step = clamp(step, -2, 2);
    if (rnd() < 0.15 * (1 - complexity)) step = 0;
    cur += step;
    cur = clamp(cur, -6, 6);
    steps.push(cur);
  }
  return steps;
}

function chooseChordProgression(style, rnd) {
  // Roman numerals in major-ish context
  const bank = {
    pop: [
      ["I","V","vi","IV"],
      ["vi","IV","I","V"],
      ["I","vi","IV","V"],
      ["I","IV","V","IV"],
    ],
    edm: [
      ["i","VI","III","VII"],
      ["i","iv","VI","V"],
      ["i","VII","VI","VII"],
    ],
    ballad: [
      ["I","iii","vi","IV"],
      ["I","V","vi","iii","IV","I","IV","V"],
      ["vi","V","IV","V","I"],
    ],
    jazzish: [
      ["ii7","V7","Imaj7","VI7"],
      ["ii7","V7","Imaj7","Imaj7"],
      ["iii7","VI7","ii7","V7"],
    ],
    random: []
  };
  if (style === "random") {
    const romans = ["I","ii","iii","IV","V","vi","vii°"];
    const len = 4 + Math.floor(rnd() * 5);
    return Array.from({ length: len }, () => romans[Math.floor(rnd()*romans.length)]);
  }
  const arr = bank[style] || bank.pop;
  return arr[Math.floor(rnd() * arr.length)];
}

function romanToDegree(roman) {
  // basic mapping (major scale degrees)
  const clean = roman.replace(/[^ivIV]+/g, "");
  const map = { I:1, II:2, III:3, IV:4, V:5, VI:6, VII:7 };
  return map[clean.toUpperCase()] || 1;
}

function degreeToScaleMidi(rootMidi, scaleSteps, degree, octaveOffset=0) {
  // degree 1..7 mapped into scaleSteps cyclically; not strict diatonic for modes with 5 notes
  const idx = (degree - 1) % scaleSteps.length;
  const oct = Math.floor((degree - 1) / scaleSteps.length);
  return rootMidi + scaleSteps[idx] + 12 * (oct + octaveOffset);
}

function generateSongEvents({
  lyrics,
  seed,
  projectName,
  bpm,
  meter,
  keyRoot,
  scaleMode,
  chordStyle,
  complexity,
  swing,
  humanize,
  structure,
  rangeOctaves,
  leadOctave,
  restProbability,
  accentProbability,
}) {
  const seedInt = hashToSeedInt(seed + "|" + projectName + "|" + bpm + "|" + meter + "|" + keyRoot + "|" + scaleMode + "|" + complexity);
  const rnd = mulberry32(seedInt);

  const sections = splitSections(lyrics);
  const beatsPerBar = meter === "3/4" ? 3 : 4;
  const scaleSteps = pickScale(scaleMode);
  const rootMidi = noteNameToMidi(keyRoot) + 12 * (leadOctave - 4);

  const chordProg = chooseChordProgression(chordStyle, rnd);

  // structure: e.g., "A A B A"
  const tokens = (structure || "A A B A").split(/\s+/).filter(Boolean);
  const labelToSectionIdx = (label) => {
    if (label === "A") return 0;
    if (label === "B") return Math.min(1, sections.length - 1);
    if (label === "C") return Math.min(2, sections.length - 1);
    const n = parseInt(label, 10);
    if (!Number.isNaN(n)) return clamp(n - 1, 0, sections.length - 1);
    return 0;
  };

  let tBeat = 0;
  const events = [];
  const chordEvents = [];

  const totalBars = [];
  for (let tok of tokens) totalBars.push(tok);

  let chordIndex = 0;

  for (let tokIdx = 0; tokIdx < totalBars.length; tokIdx++) {
    const secIdx = labelToSectionIdx(totalBars[tokIdx]);
    const sec = sections[secIdx] || sections[0];
    // Flatten lines; each line becomes a phrase
    for (const line of sec.lines) {
      const moras = splitToMoras(line);
      const durs = generateRhythm(moras.length, meter, complexity, rnd);
      const contour = generateContour(moras.length, complexity, rnd);

      // per-line harmonic chunk: advance progression by 1 chord per bar-ish
      const lineBars = Math.max(1, Math.ceil(durs.reduce((a,b)=>a+b,0)/beatsPerBar));
      for (let b = 0; b < lineBars; b++) {
        const roman = chordProg[chordIndex % chordProg.length] || "I";
        chordEvents.push({ tBeat: tBeat + b*beatsPerBar, durBeats: beatsPerBar, roman });
        chordIndex++;
      }

      let localBeat = 0;
      for (let i = 0; i < moras.length; i++) {
        // optional rests
        const isRest = rnd() < restProbability * (0.35 + 0.65*complexity);
        const dur = durs[i] || 0.5;

        // swing: delay offbeats
        const swingOffset = (swing > 0 && (Math.floor((tBeat+localBeat)/0.5) % 2 === 1))
          ? (0.5 * swing * 0.33)
          : 0;

        const start = tBeat + localBeat + swingOffset;

        // choose target degree guided by chord degree
        const activeChord = chordEvents.slice().reverse().find(c => c.tBeat <= start) || { roman: "I" };
        const chordDegree = romanToDegree(activeChord.roman);
        // contour -> scale degrees near chord tone
        const baseDegree = chordDegree + contour[i];
        const deg = clamp(baseDegree, 1, 1 + (scaleSteps.length * rangeOctaves - 1));
        let midi = degreeToScaleMidi(rootMidi, scaleSteps, deg, 0);

        // keep within range
        const minMidi = rootMidi - 12 * Math.floor(rangeOctaves/2);
        const maxMidi = rootMidi + 12 * Math.ceil(rangeOctaves/2);
        while (midi < minMidi) midi += 12;
        while (midi > maxMidi) midi -= 12;

        // accents
        const accent = rnd() < accentProbability ? 1.25 : 1.0;

        // humanize time + velocity
        const hTime = (humanize > 0) ? (rnd() - 0.5) * 0.08 * humanize : 0;
        const hVel = (humanize > 0) ? (rnd() - 0.5) * 0.12 * humanize : 0;

        events.push({
          type: isRest ? "rest" : "note",
          lyric: moras[i],
          tBeat: Math.max(0, start + hTime),
          durBeats: Math.max(0.15, dur * (isRest ? 1 : 0.98)),
          midi,
          vel: clamp(0.65 * accent + hVel, 0.2, 1.0),
          line,
          section: sec.name,
          bar: Math.floor((tBeat + localBeat) / beatsPerBar),
        });

        localBeat += dur;
      }
      // small breath between lines
      tBeat += localBeat + (0.25 + 0.25 * (1 - complexity));
    }
    // section spacing
    tBeat += beatsPerBar * 0.5;
  }

  // sort by time
  events.sort((a,b)=>a.tBeat-b.tBeat);

  return {
    version: VERSION,
    projectName,
    seed,
    bpm,
    meter,
    keyRoot,
    scaleMode,
    chordStyle,
    complexity,
    swing,
    humanize,
    structure,
    sections,
    chordProg,
    chordEvents,
    events,
    totalBeats: tBeat,
  };
}

// ----- ABC notation (simple, monophonic) -----
function midiToAbcNote(midi, keyRoot="C4") {
  // ABC: middle C is C, octave markers; this is simplistic (uses sharps)
  const name = midiToNoteName(midi); // e.g., C#4
  const m = /^([A-G])(#)?(\d+)$/.exec(name);
  if (!m) return "C";
  let [_, L, sharp, octStr] = m;
  const oct = parseInt(octStr, 10);
  const baseOct = 4; // ABC middle octave around 4
  let note = L;
  if (sharp) note = "^" + note;

  // ABC octave: C (oct 4) => C, oct 5 => c, oct 6 => c', oct 3 => C,
  if (oct > baseOct) {
    note = note.toLowerCase();
    const marks = oct - baseOct - 1;
    if (marks > 0) note += "'".repeat(marks);
  } else if (oct < baseOct) {
    const marks = baseOct - oct;
    if (marks > 0) note += ",".repeat(marks);
  }
  return note;
}

function durToAbcLen(durBeats, meter) {
  // Set L:1/8 as base; for 4/4 beat=1 => 1/4 => length 2 (because 1/8 base)
  // For 3/4, same
  const base = 0.5; // 1/8 note = 0.5 beat if beat=quarter
  const units = Math.round(durBeats / base);
  if (units === 1) return "";
  return String(units);
}

function toABC(project) {
  const meter = project.meter;
  const bpm = project.bpm;
  const title = project.projectName || "Lyrics Song";
  const key = (project.keyRoot || "C4").replace(/\d+$/, ""); // "C"
  const beatsPerBar = meter === "3/4" ? 3 : 4;

  let abc = "";
  abc += `X:1\n`;
  abc += `T:${title}\n`;
  abc += `M:${meter}\n`;
  abc += `L:1/8\n`;
  abc += `Q:1/4=${bpm}\n`;
  abc += `K:${key}\n`;

  let curBarBeat = 0;
  for (const ev of project.events) {
    if (ev.type === "rest") {
      const len = durToAbcLen(ev.durBeats, meter);
      abc += `z${len} `;
      curBarBeat += ev.durBeats;
    } else {
      const n = midiToAbcNote(ev.midi, project.keyRoot);
      const len = durToAbcLen(ev.durBeats, meter);
      abc += `${n}${len} `;
      curBarBeat += ev.durBeats;
    }
    if (curBarBeat >= beatsPerBar - 1e-6) {
      abc += `|\n`;
      curBarBeat = 0;
    }
  }
  abc += `|\n`;
  return abc;
}

// ----- MIDI export (very simple SMF Type 0, monophonic) -----
function writeVarLen(value) {
  let buffer = value & 0x7F;
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= ((value & 0x7F) | 0x80);
  }
  const out = [];
  while (true) {
    out.push(buffer & 0xFF);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return out;
}

function toMIDI(project) {
  const ticksPerBeat = 480;
  const bpm = project.bpm;
  const usPerBeat = Math.round(60000000 / bpm);

  const bytes = [];
  const pushStr = (s) => { for (let i=0;i<s.length;i++) bytes.push(s.charCodeAt(i)); };
  const push32 = (n) => { bytes.push((n>>>24)&255,(n>>>16)&255,(n>>>8)&255,n&255); };
  const push16 = (n) => { bytes.push((n>>>8)&255,n&255); };

  // Header chunk
  pushStr("MThd"); push32(6);
  push16(0); // format 0
  push16(1); // one track
  push16(ticksPerBeat);

  // Track chunk (build track bytes first)
  const tr = [];
  const trPush = (...arr) => tr.push(...arr);

  // tempo meta
  trPush(...writeVarLen(0), 0xFF, 0x51, 0x03, (usPerBeat>>16)&255, (usPerBeat>>8)&255, usPerBeat&255);
  // time signature meta (approx)
  const meter = project.meter || "4/4";
  const [num, den] = meter.split("/").map(x=>parseInt(x,10));
  const dd = den === 8 ? 3 : den === 4 ? 2 : den === 2 ? 1 : 2;
  trPush(...writeVarLen(0), 0xFF, 0x58, 0x04, num&255, dd&255, 24, 8);

  // program change (voice-ish)
  trPush(...writeVarLen(0), 0xC0, 52); // Choir Aahs-ish in GM

  // note events
  const evs = project.events.filter(e=>e.type==="note").slice().sort((a,b)=>a.tBeat-b.tBeat);
  let lastTick = 0;
  for (const ev of evs) {
    const startTick = Math.max(0, Math.round(ev.tBeat * ticksPerBeat));
    const durTick = Math.max(1, Math.round(ev.durBeats * ticksPerBeat * 0.98));
    const dt = startTick - lastTick;
    const vel = clamp(Math.round(ev.vel * 100), 1, 127);

    // note on
    trPush(...writeVarLen(dt), 0x90, ev.midi & 127, vel);
    // note off
    trPush(...writeVarLen(durTick), 0x80, ev.midi & 127, 0);
    lastTick = startTick + durTick;
  }

  // end of track
  trPush(...writeVarLen(0), 0xFF, 0x2F, 0x00);

  // Write track chunk
  pushStr("MTrk");
  push32(tr.length);
  bytes.push(...tr);

  return new Uint8Array(bytes);
}

// ----- WebAudio "sing voice" engine -----
function createVoiceNode(ctx, opts) {
  // Enhanced singing-ish synth:
  // - osc mix -> formant filters (2 bandpasses) -> gain
  // - noise source for breath + consonant
  const osc1 = ctx.createOscillator();
  const osc2 = ctx.createOscillator();
  const gain = ctx.createGain();

  // Formants
  const f1 = ctx.createBiquadFilter();
  const f2 = ctx.createBiquadFilter();
  f1.type = "bandpass";
  f2.type = "bandpass";
  f1.Q.value = opts.q1 ?? 10;
  f2.Q.value = opts.q2 ?? 12;

  // Light "air"
  const air = ctx.createBiquadFilter();
  air.type = "highshelf";
  air.frequency.value = 4500;
  air.gain.value = opts.airGain ?? 2.5;

  // Mix oscillators
  osc1.type = opts.wave1 || "sawtooth";
  osc2.type = opts.wave2 || "triangle";
  const mix1 = ctx.createGain();
  const mix2 = ctx.createGain();
  mix1.gain.value = opts.mix1 ?? 0.62;
  mix2.gain.value = opts.mix2 ?? 0.38;

  const sum = ctx.createGain();
  osc1.connect(mix1).connect(sum);
  osc2.connect(mix2).connect(sum);

  // Noise for breath/consonants
  const noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.5), ctx.sampleRate);
  const data = noiseBuf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.6;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuf;
  noise.loop = true;

  const noiseGain = ctx.createGain();
  noiseGain.gain.value = 0;

  const noiseHP = ctx.createBiquadFilter();
  noiseHP.type = "highpass";
  noiseHP.frequency.value = 900;

  noise.connect(noiseHP).connect(noiseGain);

  // Routing
  sum.connect(f1);
  f1.connect(f2);
  f2.connect(air);
  air.connect(gain);
  noiseGain.connect(gain);

  // vibrato
  const vibratoOsc = ctx.createOscillator();
  const vibratoGain = ctx.createGain();
  vibratoOsc.type = "sine";
  vibratoOsc.frequency.value = opts.vibratoHz || 5.4;
  vibratoGain.gain.value = opts.vibratoDepth || 10; // cents-ish
  vibratoOsc.connect(vibratoGain);
  vibratoGain.connect(osc1.detune);
  vibratoGain.connect(osc2.detune);

  gain.gain.value = 0;

  const start = (when) => {
    osc1.start(when);
    osc2.start(when);
    noise.start(when);
    vibratoOsc.start(when);
  };
  const stop = (when) => {
    try { osc1.stop(when); } catch {}
    try { osc2.stop(when); } catch {}
    try { noise.stop(when); } catch {}
    try { vibratoOsc.stop(when); } catch {}
  };

  return {
    output: gain,
    osc1, osc2,
    gain,
    f1, f2,
    noiseGain,
    vibratoOsc,
    vibratoGain,
    start, stop
  };
}

function vowelToFormantHz(vowel) {
  // Rough 2-formant centers (F1, F2) for Japanese-ish vowels (very approximate)
  const v = vowel;
  if (/[あぁa]/i.test(v)) return [800, 1200];
  if (/[いぃi]/i.test(v)) return [350, 2800];
  if (/[うぅu]/i.test(v)) return [450, 1200];
  if (/[えぇe]/i.test(v)) return [500, 2200];
  if (/[おぉo]/i.test(v)) return [600, 1000];
  return [500, 1500];
}

function guessVowel(token) {
  // naive mapping for Japanese kana to last vowel
  const t = token || "";
  const map = [
    { re: /[かがさざただなはばぱまやらわぁ]/, v: "a" },
    { re: /[きぎしじちぢにひびぴみりぃ]/, v: "i" },
    { re: /[くぐすずつづぬふぶぷむゆるぅ]/, v: "u" },
    { re: /[けげせぜてでねへべぺめれぇ]/, v: "e" },
    { re: /[こごそぞとどのほぼぽもよろをぉ]/, v: "o" },
    { re: /[んン]/, v: "u" },
  ];
  for (const it of map) if (it.re.test(t)) return it.v;
  if (/[aeiou]/i.test(t)) {
    const m = t.match(/[aeiou]/ig);
    return m ? m[m.length-1].toLowerCase() : "a";
  }
  return "a";
}

async function ensureAbcJs() {
  if (window.ABCJS) return true;
  // load from CDN
  const url = "https://cdn.jsdelivr.net/npm/abcjs@6.2.3/dist/abcjs-basic-min.js";
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.async = true;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return !!window.ABCJS;
}

// ----- File helpers -----
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toWavBlob(float32, sampleRate) {
  // mono float32 [-1,1] -> 16-bit PCM WAV
  const numSamples = float32.length;
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  function writeStr(offset, s) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  }

  let offset = 0;
  writeStr(offset, "RIFF"); offset += 4;
  view.setUint32(offset, 36 + numSamples * 2, true); offset += 4;
  writeStr(offset, "WAVE"); offset += 4;
  writeStr(offset, "fmt "); offset += 4;
  view.setUint32(offset, 16, true); offset += 4;
  view.setUint16(offset, 1, true); offset += 2; // PCM
  view.setUint16(offset, 1, true); offset += 2; // mono
  view.setUint32(offset, sampleRate, true); offset += 4;
  view.setUint32(offset, sampleRate * 2, true); offset += 4;
  view.setUint16(offset, 2, true); offset += 2;
  view.setUint16(offset, 16, true); offset += 2;

  writeStr(offset, "data"); offset += 4;
  view.setUint32(offset, numSamples * 2, true); offset += 4;

  for (let i = 0; i < numSamples; i++) {
    const s = clamp(float32[i], -1, 1);
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function useLocalStorageState(key, initialValue) {
  const [v, setV] = useState(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initialValue;
      return JSON.parse(raw);
    } catch {
      return initialValue;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
  }, [key, v]);
  return [v, setV];
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ----- Main App -----
export default function App() {
  // Core inputs
  const [projectName, setProjectName] = useLocalStorageState("lyricSong.projectName", DEFAULT_PROJECT_NAME);
  const [seed, setSeed] = useLocalStorageState("lyricSong.seed", DEFAULT_SEED);
  const [lyrics, setLyrics] = useLocalStorageState("lyricSong.lyrics", "君の声が\n夜を照らす\n\n明日の風に\n願いをのせて");
  const [bpm, setBpm] = useLocalStorageState("lyricSong.bpm", 110);
  const [meter, setMeter] = useLocalStorageState("lyricSong.meter", "4/4");
  const [keyRoot, setKeyRoot] = useLocalStorageState("lyricSong.keyRoot", "C4");
  const [scaleMode, setScaleMode] = useLocalStorageState("lyricSong.scaleMode", "major");
  const [chordStyle, setChordStyle] = useLocalStorageState("lyricSong.chordStyle", "pop");

  const [complexity, setComplexity] = useLocalStorageState("lyricSong.complexity", 0.55);
  const [swing, setSwing] = useLocalStorageState("lyricSong.swing", 0.15);
  const [humanize, setHumanize] = useLocalStorageState("lyricSong.humanize", 0.35);

  const [portamento, setPortamento] = useLocalStorageState("lyricSong.portamento", 0.06); // sec
  const [breathAmount, setBreathAmount] = useLocalStorageState("lyricSong.breathAmount", 0.22);
  const [vibratoDepth, setVibratoDepth] = useLocalStorageState("lyricSong.vibratoDepth", 10); // cents-ish
  const [vibratoHz, setVibratoHz] = useLocalStorageState("lyricSong.vibratoHz", 5.4);
  const [consonantAmount, setConsonantAmount] = useLocalStorageState("lyricSong.consonantAmount", 0.25);

  const [structure, setStructure] = useLocalStorageState("lyricSong.structure", "A A B A");
  const [rangeOctaves, setRangeOctaves] = useLocalStorageState("lyricSong.rangeOctaves", 2);
  const [leadOctave, setLeadOctave] = useLocalStorageState("lyricSong.leadOctave", 4);

  const [restProbability, setRestProbability] = useLocalStorageState("lyricSong.restProbability", 0.04);
  const [accentProbability, setAccentProbability] = useLocalStorageState("lyricSong.accentProbability", 0.18);

  // Voice & playback
  const [voicePreset, setVoicePreset] = useLocalStorageState("lyricSong.voicePreset", "choir");
  const [speechOverlay, setSpeechOverlay] = useLocalStorageState("lyricSong.speechOverlay", false);
  const [loop, setLoop] = useLocalStorageState("lyricSong.loop", false);
  const [countInBars, setCountInBars] = useLocalStorageState("lyricSong.countInBars", 1);
  const [metronome, setMetronome] = useLocalStorageState("lyricSong.metronome", true);
  const [masterVol, setMasterVol] = useLocalStorageState("lyricSong.masterVol", 0.85);

  const [status, setStatus] = useState("Ready");
  const [tab, setTab] = useState("compose"); // compose | arrange | notation | export | features

  const [project, setProject] = useState(null);
  const abc = useMemo(() => (project ? toABC(project) : ""), [project]);

  // playback refs
  const audioRef = useRef(null);
  const nodesRef = useRef({ playing: false, startTime: 0, sched: [], timer: null });
  const [playheadSec, setPlayheadSec] = useState(0);

  const abcDivRef = useRef(null);

  // Generate project
  useEffect(() => {
    const p = generateSongEvents({
      lyrics,
      seed,
      projectName,
      bpm: Number(bpm),
      meter,
      keyRoot,
      scaleMode,
      chordStyle,
      complexity: Number(complexity),
      swing: Number(swing),
      humanize: Number(humanize),
      structure,
      rangeOctaves: Number(rangeOctaves),
      leadOctave: Number(leadOctave),
      restProbability: Number(restProbability),
      accentProbability: Number(accentProbability),
    });
    setProject(p);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lyrics, seed, projectName, bpm, meter, keyRoot, scaleMode, chordStyle, complexity, swing, humanize, structure, rangeOctaves, leadOctave, restProbability, accentProbability]);

  // Render ABC when tab opens
  useEffect(() => {
    let cancelled = false;
    async function render() {
      if (tab !== "notation") return;
      if (!abcDivRef.current) return;
      try {
        await ensureAbcJs();
        if (cancelled) return;
        abcDivRef.current.innerHTML = "";
        window.ABCJS.renderAbc(abcDivRef.current, abc, {
          responsive: "resize",
          add_classes: true,
          staffwidth: 740,
        });
      } catch (e) {
        // fallback: show ABC text only
      }
    }
    render();
    return () => { cancelled = true; };
  }, [tab, abc]);

  function initAudio() {
    if (audioRef.current) return audioRef.current;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    audioRef.current = ctx;
    return ctx;
  }

  function stopPlayback() {
    const st = nodesRef.current;
    if (st.timer) {
      clearInterval(st.timer);
      st.timer = null;
    }
    if (st.sched && st.sched.length) {
      st.sched.forEach(n => {
        try { n.stop(ctxNow(n.ctx) + 0.01); } catch {}
      });
    }
    st.sched = [];
    st.playing = false;
    setStatus("Stopped");
    setPlayheadSec(0);

    // stop speech
    if (speechOverlay && window.speechSynthesis) {
      try { window.speechSynthesis.cancel(); } catch {}
    }
  }

  function ctxNow(ctx) {
    return ctx.currentTime;
  }

  function voiceOptions(preset) {
  const common = {
    vibratoHz: Number(vibratoHz),
    vibratoDepth: Number(vibratoDepth),
  };
  switch (preset) {
    case "soft":
      return { ...common, wave1: "triangle", wave2: "sine", q1: 8, q2: 10, mix1: 0.55, mix2: 0.45, airGain: 1.5 };
    case "bright":
      return { ...common, wave1: "sawtooth", wave2: "square", q1: 12, q2: 14, mix1: 0.66, mix2: 0.34, airGain: 3.5 };
    case "robot":
      return { ...common, wave1: "square", wave2: "square", q1: 16, q2: 16, mix1: 0.6, mix2: 0.4, airGain: 0.5 };
    case "choir":
    default:
      return { ...common, wave1: "sawtooth", wave2: "triangle", q1: 10, q2: 12, mix1: 0.62, mix2: 0.38, airGain: 2.5 };
  }
}

  function scheduleMetronome(ctx, when, durSec, bpmLocal, meterLocal) {
    if (!metronome) return;
    const beatsPerBar = meterLocal === "3/4" ? 3 : 4;
    const beatSec = 60 / bpmLocal;

    const click = (time, strong) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "sine";
      o.frequency.setValueAtTime(strong ? 1200 : 900, time);
      g.gain.setValueAtTime(0, time);
      g.gain.linearRampToValueAtTime(0.4 * masterVol, time + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
      o.connect(g).connect(ctx.destination);
      o.start(time);
      o.stop(time + 0.06);
    };

    const totalBeats = durSec / beatSec;
    for (let b = 0; b < totalBeats; b++) {
      const t = when + b * beatSec;
      click(t, (b % beatsPerBar) === 0);
    }
  }

  function speakLyricsKaraoke(project, ctx, startWhenSec) {
    if (!speechOverlay || !window.speechSynthesis) return;
    // Cancel any current speech
    try { window.speechSynthesis.cancel(); } catch {}

    const beatSec = 60 / project.bpm;
    const notes = project.events.filter(e => e.type === "note");
    const chunks = [];
    // Group into small bursts for steadier speech scheduling
    let buf = [];
    let lastBeat = null;
    for (const n of notes) {
      if (lastBeat == null) lastBeat = n.tBeat;
      if (n.tBeat - lastBeat > 2.0 || buf.length > 18) {
        chunks.push({ tBeat: lastBeat, text: buf.join("") });
        buf = [];
        lastBeat = n.tBeat;
      }
      buf.push(n.lyric);
    }
    if (buf.length) chunks.push({ tBeat: lastBeat, text: buf.join("") });

    const baseTimeMs = performance.now() + startWhenSec * 1000;

    for (const ch of chunks) {
      const u = new SpeechSynthesisUtterance(ch.text);
      u.rate = clamp(0.9 + (project.bpm - 100) / 400, 0.7, 1.15);
      u.pitch = clamp(1.0 + (project.complexity - 0.5) * 0.35, 0.6, 1.4);
      u.volume = 0.8;

      const tMs = baseTimeMs + ch.tBeat * beatSec * 1000;
      const delay = Math.max(0, tMs - performance.now());
      setTimeout(() => {
        try { window.speechSynthesis.speak(u); } catch {}
      }, delay);
    }
  }

  async function play() {
    if (!project) return;
    const ctx = initAudio();
    await ctx.resume();

    stopPlayback(); // ensure clean

    const st = nodesRef.current;
    st.playing = true;
    setStatus("Playing…");

    const beatSec = 60 / project.bpm;
    const countInBeats = (meter === "3/4" ? 3 : 4) * Number(countInBars);
    const startWhen = ctxNow(ctx) + 0.12; // small safety
    const musicStartWhen = startWhen + countInBeats * beatSec;

    // master gain
    const master = ctx.createGain();
    master.gain.value = masterVol;
    master.connect(ctx.destination);

    // schedule metronome (count-in + music)
    const totalSec = (countInBeats + project.totalBeats) * beatSec;
    scheduleMetronome(ctx, startWhen, totalSec, project.bpm, project.meter);

    // schedule voice notes
    const voicePresetOpts = voiceOptions(voicePreset);

    const nodes = [];
    const notes = project.events;
    for (const ev of notes) {
      if (ev.type !== "note") continue;

      const v = createVoiceNode(ctx, voicePresetOpts);
      v.output.connect(master);

      const f0 = midiToFreq(ev.midi);
      const t0 = musicStartWhen + ev.tBeat * beatSec;
      const t1 = t0 + ev.durBeats * beatSec;

      // pitch with portamento (glide)
const glide = Math.max(0, Number(portamento));
v.osc1.frequency.setValueAtTime(f0 * 0.985, t0);
v.osc2.frequency.setValueAtTime(f0 * 0.985 * 0.995, t0);
v.osc1.frequency.exponentialRampToValueAtTime(f0, t0 + glide);
v.osc2.frequency.exponentialRampToValueAtTime(f0 * 0.995, t0 + glide);

// formants (2 bandpasses) based on vowel
const vowel = guessVowel(ev.lyric);
const [f1c, f2c] = vowelToFormantHz(vowel);
v.f1.frequency.setValueAtTime(f1c, t0);
v.f2.frequency.setValueAtTime(f2c, t0);

// envelope (more "sung" shape)
const g = v.gain.gain;
const a = 0.008;
const d = 0.06;
const s = 0.62 * ev.vel;
const r = 0.08;

g.setValueAtTime(0.0001, t0);
g.linearRampToValueAtTime(0.40 * ev.vel, t0 + a);
g.linearRampToValueAtTime(s, Math.min(t1, t0 + a + d));
g.setValueAtTime(s, Math.max(t0 + a + d, t1 - r));
g.linearRampToValueAtTime(0.0001, t1);

// Breath + consonant noise
const ng = v.noiseGain.gain;
const breath = clamp(Number(breathAmount), 0, 1) * 0.12 * ev.vel;
const cons = clamp(Number(consonantAmount), 0, 1) * 0.22 * ev.vel;

ng.setValueAtTime(0.0001, t0);
ng.linearRampToValueAtTime(cons, t0 + 0.006);
ng.linearRampToValueAtTime(breath, t0 + 0.03);
ng.setValueAtTime(breath, Math.max(t0 + 0.03, t1 - 0.10));
ng.linearRampToValueAtTime(0.0001, t1);

// Vibrato fade in / stronger near tail
const vd = v.vibratoGain.gain;
const baseVib = clamp(Number(vibratoDepth), 0, 40);
vd.setValueAtTime(baseVib * 0.25, t0);
vd.linearRampToValueAtTime(baseVib * 0.65, t0 + 0.12);
vd.linearRampToValueAtTime(baseVib * 1.0, Math.max(t0 + 0.2, t1 - 0.12));

      v.start(t0);
      v.stop(t1 + 0.02);
      nodes.push({ ctx, stop: (when) => v.stop(when) });
    }

    st.sched = nodes;

    // speech overlay for "lyrics singing" feel
    speakLyricsKaraoke(project, ctx, (musicStartWhen - performance.now()/1000) < 0 ? 0 : (musicStartWhen - ctxNow(ctx)));

    // Playhead UI timer
    const startPerf = performance.now();
    st.startTime = startPerf;
    st.timer = setInterval(() => {
      if (!st.playing) return;
      const elapsed = (performance.now() - startPerf) / 1000;
      const ph = Math.max(0, elapsed - countInBeats * beatSec);
      setPlayheadSec(ph);
      const endSec = project.totalBeats * beatSec;
      if (ph >= endSec + 0.1) {
        if (loop) {
          play().catch(()=>{});
        } else {
          stopPlayback();
        }
      }
    }, 60);
  }

  async function exportWav() {
    if (!project) return;
    setStatus("Rendering WAV…");
    try {
      const AudioContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!AudioContext) throw new Error("OfflineAudioContext not supported.");

      const sampleRate = 44100;
      const beatSec = 60 / project.bpm;
      const beatsPerBar = project.meter === "3/4" ? 3 : 4;
      const countInBeats = beatsPerBar * Number(countInBars);
      const durationSec = (countInBeats + project.totalBeats + 1) * beatSec;
      const ctx = new AudioContext(1, Math.ceil(durationSec * sampleRate), sampleRate);

      const master = ctx.createGain();
      master.gain.value = masterVol;
      master.connect(ctx.destination);

      // render notes
      const voicePresetOpts = voiceOptions(voicePreset);
      const startWhen = 0.0;
      const musicStart = startWhen + countInBeats * beatSec;

      for (const ev of project.events) {
        if (ev.type !== "note") continue;
        const v = createVoiceNode(ctx, voicePresetOpts);
        v.output.connect(master);

        const f0 = midiToFreq(ev.midi);
        const t0 = musicStart + ev.tBeat * beatSec;
        const t1 = t0 + ev.durBeats * beatSec;

        // pitch with portamento
const glide = Math.max(0, Number(portamento));
v.osc1.frequency.setValueAtTime(f0 * 0.985, t0);
v.osc2.frequency.setValueAtTime(f0 * 0.985 * 0.995, t0);
v.osc1.frequency.exponentialRampToValueAtTime(f0, t0 + glide);
v.osc2.frequency.exponentialRampToValueAtTime(f0 * 0.995, t0 + glide);

// formants
const vowel = guessVowel(ev.lyric);
const [f1c, f2c] = vowelToFormantHz(vowel);
v.f1.frequency.setValueAtTime(f1c, t0);
v.f2.frequency.setValueAtTime(f2c, t0);

// envelope
const g = v.gain.gain;
g.setValueAtTime(0.0001, t0);
g.linearRampToValueAtTime(0.40 * ev.vel, t0 + 0.008);
g.linearRampToValueAtTime(0.62 * ev.vel, Math.min(t1, t0 + 0.07));
g.setValueAtTime(0.62 * ev.vel, Math.max(t0 + 0.07, t1 - 0.08));
g.linearRampToValueAtTime(0.0001, t1);

// noise
const ng = v.noiseGain.gain;
const breath = clamp(Number(breathAmount), 0, 1) * 0.12 * ev.vel;
const cons = clamp(Number(consonantAmount), 0, 1) * 0.22 * ev.vel;
ng.setValueAtTime(0.0001, t0);
ng.linearRampToValueAtTime(cons, t0 + 0.006);
ng.linearRampToValueAtTime(breath, t0 + 0.03);
ng.setValueAtTime(breath, Math.max(t0 + 0.03, t1 - 0.10));
ng.linearRampToValueAtTime(0.0001, t1);

// vibrato fade
const vd = v.vibratoGain.gain;
const baseVib = clamp(Number(vibratoDepth), 0, 40);
vd.setValueAtTime(baseVib * 0.25, t0);
vd.linearRampToValueAtTime(baseVib * 0.65, t0 + 0.12);
vd.linearRampToValueAtTime(baseVib * 1.0, Math.max(t0 + 0.2, t1 - 0.12));

        v.start(t0);
        v.stop(t1 + 0.02);
      }

      const rendered = await ctx.startRendering();
      const ch0 = rendered.getChannelData(0);
      const blob = toWavBlob(ch0, sampleRate);
      downloadBlob(blob, `${project.projectName || "song"}.wav`);
      setStatus("WAV exported.");
    } catch (e) {
      console.error(e);
      setStatus("WAV export failed (browser limitation). Try MIDI/ABC/JSON.");
    }
  }

  function exportJson() {
    if (!project) return;
    downloadBlob(new Blob([JSON.stringify(project, null, 2)], { type: "application/json" }), `${project.projectName || "song"}.json`);
  }

  function exportAbc() {
    if (!project) return;
    downloadBlob(new Blob([abc], { type: "text/plain" }), `${project.projectName || "song"}.abc`);
  }

  function exportMidi() {
    if (!project) return;
    const midiBytes = toMIDI(project);
    downloadBlob(new Blob([midiBytes], { type: "audio/midi" }), `${project.projectName || "song"}.mid`);
  }

  function randomizeSeed() {
    const s = Math.random().toString(36).slice(2, 10);
    setSeed(s);
  }

  function insertDemoLyrics() {
    setLyrics("星が降る夜に\n君の名を呼んだ\n\n涙のあとに\n笑顔を描いて\n\n遠い未来へ\n手を伸ばす");
  }

  const beatsPerBar = meter === "3/4" ? 3 : 4;
  const totalSec = project ? (project.totalBeats * (60 / project.bpm)) : 0;

  // “~100 features”: Implemented vs placeholders list (honest)
  const featureList = useMemo(() => ([
    { name: "歌詞入力→自動リズム生成", done: true },
    { name: "メロディ自動生成（スケール/キー/音域）", done: true },
    { name: "複雑さスライダー（リズム/跳躍/休符）", done: true },
    { name: "スウィング", done: true },
    { name: "ヒューマナイズ（タイミング/強弱）", done: true },
    { name: "コード進行生成（pop/edm/ballad/jazzish/random）", done: true },
    { name: "セクション構造（A A B A など）", done: true },
    { name: "カウントイン", done: true },
    { name: "メトロノーム", done: true },
    { name: "ループ再生", done: true },
    { name: "簡易“歌声”合成（WebAudio）", done: true },
    { name: "SpeechSynthesis オーバーレイ（擬似カラオケ）", done: true },
    { name: "ABC 楽譜出力", done: true },
    { name: "ABCJS による楽譜レンダリング（動的ロード）", done: true },
    { name: "MIDI エクスポート（単旋律）", done: true },
    { name: "WAV エクスポート（OfflineAudioContext, best-effort）", done: true },
    { name: "プロジェクトJSON保存/書き出し", done: true },
    { name: "ローカルストレージで設定保存", done: true },
    { name: "再生位置表示", done: true },

    // placeholders toward “~100”
    { name: "歌詞の韻/母音一致解析", done: false },
    { name: "自動サビ判定", done: false },
    { name: "和音（ハーモニー/コーラス）生成", done: false },
    { name: "ベースライン生成", done: false },
    { name: "ドラムパターン生成", done: false },
    { name: "伴奏（アルペジオ/ストローク）", done: false },
    { name: "MIDIインポート", done: false },
    { name: "MusicXML出力", done: false },
    { name: "歌詞の字幕ハイライト（単語単位）", done: false },
    { name: "カスタムリズムパターン編集UI", done: false },
    { name: "編集可能なピアノロール", done: false },
    { name: "スケール外音（ブルーノート/借用和音）", done: false },
    { name: "転調", done: false },
    { name: "拍子変更（途中で）", done: false },
    { name: "オートメーション（フィルタ/ボリューム）", done: false },
    { name: "エフェクト（リバーブ/ディレイ）", done: false },
    { name: "AIボーカロイド系合成（外部API）", done: false },
    { name: "スタイルプリセット（J-POP/演歌/ロック等）", done: false },
    { name: "共同編集/共有リンク", done: false },
    { name: "プロジェクト一覧/検索", done: false },
    { name: "アクセシビリティ強化（キーボード操作）", done: false },
  ]), []);

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <header style={{ display: "flex", gap: 12, alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 22 }}>Lyrics → Rhythm Song Maker</h1>
          <div style={{ opacity: 0.7, fontSize: 12 }}>App.js single-file demo · v{VERSION}</div>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, opacity: 0.8 }}>Status: {status}</span>
          <button onClick={play} style={btnPrimary}>▶ Play</button>
          <button onClick={stopPlayback} style={btn}>■ Stop</button>
        </div>
      </header>

      <nav style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <TabButton label="Compose" active={tab==="compose"} onClick={()=>setTab("compose")} />
        <TabButton label="Arrange" active={tab==="arrange"} onClick={()=>setTab("arrange")} />
        <TabButton label="Notation" active={tab==="notation"} onClick={()=>setTab("notation")} />
        <TabButton label="Export" active={tab==="export"} onClick={()=>setTab("export")} />
        <TabButton label="Features" active={tab==="features"} onClick={()=>setTab("features")} />
      </nav>

      {tab === "compose" && (
        <section style={card}>
          <h2 style={h2}>1) 歌詞</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1.3fr 0.7fr", gap: 12 }}>
            <div>
              <textarea
                value={lyrics}
                onChange={(e)=>setLyrics(e.target.value)}
                rows={12}
                style={{ width: "100%", padding: 10, fontSize: 14, lineHeight: 1.35, borderRadius: 10, border: "1px solid #ddd" }}
                placeholder="歌詞を入力してください（改行でフレーズ、空行でセクション）"
              />
              <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={insertDemoLyrics} style={btn}>デモ歌詞</button>
                <button onClick={() => setLyrics("")} style={btn}>クリア</button>
                <button onClick={randomizeSeed} style={btn}>シード変更</button>
              </div>
              <p style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                ※ ブラウザ内の簡易“歌声”合成です（発音は疑似）。下の「歌声」スライダーで“歌ってる感”を調整できます。本格的な歌声合成は外部API/モデルが必要です。
              </p>
            </div>

            <div>
              <h3 style={h3}>プロジェクト</h3>
              <Labeled label="Project name">
                <input value={projectName} onChange={(e)=>setProjectName(e.target.value)} style={input} />
              </Labeled>
              <Labeled label="Seed (再現性)">
                <input value={seed} onChange={(e)=>setSeed(e.target.value)} style={input} />
              </Labeled>

              <h3 style={h3}>再生</h3>
              <Row>
                <Labeled label="Loop">
                  <input type="checkbox" checked={loop} onChange={(e)=>setLoop(e.target.checked)} />
                </Labeled>
                <Labeled label="Metronome">
                  <input type="checkbox" checked={metronome} onChange={(e)=>setMetronome(e.target.checked)} />
                </Labeled>
              </Row>
              <Row>
                <Labeled label="Count-in (bars)">
                  <input type="number" min={0} max={4} value={countInBars} onChange={(e)=>setCountInBars(Number(e.target.value))} style={inputSmall} />
                </Labeled>
                <Labeled label="Volume">
                  <input type="range" min={0} max={1} step={0.01} value={masterVol} onChange={(e)=>setMasterVol(Number(e.target.value))} />
                </Labeled>
              </Row>

              <Labeled label="Speech overlay (擬似カラオケ)">
                <input type="checkbox" checked={speechOverlay} onChange={(e)=>setSpeechOverlay(e.target.checked)} />
              </Labeled>

              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.8 }}>
                長さ: {formatTime(totalSec)} / 再生位置: {formatTime(playheadSec)}
              </div>
            </div>
          </div>
        </section>
      )}

      {tab === "arrange" && (
        <section style={card}>
          <h2 style={h2}>2) 音楽設定</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <h3 style={h3}>テンポ・拍子・キー</h3>
              <Row>
                <Labeled label="BPM">
                  <input type="number" min={40} max={220} value={bpm} onChange={(e)=>setBpm(Number(e.target.value))} style={inputSmall} />
                </Labeled>
                <Labeled label="Meter">
                  <select value={meter} onChange={(e)=>setMeter(e.target.value)} style={input}>
                    <option value="4/4">4/4</option>
                    <option value="3/4">3/4</option>
                  </select>
                </Labeled>
              </Row>

              <Row>
                <Labeled label="Key root">
                  <select value={keyRoot} onChange={(e)=>setKeyRoot(e.target.value)} style={input}>
                    {["C4","D4","E4","F4","G4","A4","B4"].map(k => <option key={k} value={k}>{k}</option>)}
                    {["C#4","D#4","F#4","G#4","A#4"].map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                </Labeled>
                <Labeled label="Scale">
                  <select value={scaleMode} onChange={(e)=>setScaleMode(e.target.value)} style={input}>
                    <option value="major">Major</option>
                    <option value="minor">Minor</option>
                    <option value="pentatonic">Pentatonic</option>
                    <option value="dorian">Dorian</option>
                    <option value="harmonic_minor">Harmonic minor</option>
                  </select>
                </Labeled>
              </Row>

              <Row>
                <Labeled label="Chord style">
                  <select value={chordStyle} onChange={(e)=>setChordStyle(e.target.value)} style={input}>
                    <option value="pop">Pop</option>
                    <option value="edm">EDM</option>
                    <option value="ballad">Ballad</option>
                    <option value="jazzish">Jazz-ish</option>
                    <option value="random">Random</option>
                  </select>
                </Labeled>
                <Labeled label="Structure">
                  <input value={structure} onChange={(e)=>setStructure(e.target.value)} style={input} placeholder="A A B A" />
                </Labeled>
              </Row>

              <h3 style={h3}>複雑さ</h3>
              <Labeled label={`Complexity: ${complexity.toFixed(2)}`}>
                <input type="range" min={0} max={1} step={0.01} value={complexity} onChange={(e)=>setComplexity(Number(e.target.value))} />
              </Labeled>
              <Labeled label={`Swing: ${swing.toFixed(2)}`}>
                <input type="range" min={0} max={0.6} step={0.01} value={swing} onChange={(e)=>setSwing(Number(e.target.value))} />
              </Labeled>
              <Labeled label={`Humanize: ${humanize.toFixed(2)}`}>
                <input type="range" min={0} max={1} step={0.01} value={humanize} onChange={(e)=>setHumanize(Number(e.target.value))} />
              </Labeled>

<h3 style={h3}>歌声（歌ってる感）</h3>
<Labeled label={`Portamento (glide sec): ${Number(portamento).toFixed(2)}`}>
  <input type="range" min={0} max={0.25} step={0.005} value={portamento} onChange={(e)=>setPortamento(Number(e.target.value))} />
</Labeled>
<Labeled label={`Vibrato Hz: ${Number(vibratoHz).toFixed(1)}`}>
  <input type="range" min={3} max={8} step={0.1} value={vibratoHz} onChange={(e)=>setVibratoHz(Number(e.target.value))} />
</Labeled>
<Labeled label={`Vibrato depth: ${Number(vibratoDepth).toFixed(0)}`}>
  <input type="range" min={0} max={35} step={1} value={vibratoDepth} onChange={(e)=>setVibratoDepth(Number(e.target.value))} />
</Labeled>
<Labeled label={`Breath amount: ${Number(breathAmount).toFixed(2)}`}>
  <input type="range" min={0} max={1} step={0.01} value={breathAmount} onChange={(e)=>setBreathAmount(Number(e.target.value))} />
</Labeled>
<Labeled label={`Consonant amount: ${Number(consonantAmount).toFixed(2)}`}>
  <input type="range" min={0} max={1} step={0.01} value={consonantAmount} onChange={(e)=>setConsonantAmount(Number(e.target.value))} />
</Labeled>


              <Row>
                <Labeled label="Rest prob.">
                  <input type="number" min={0} max={0.5} step={0.01} value={restProbability} onChange={(e)=>setRestProbability(Number(e.target.value))} style={inputSmall} />
                </Labeled>
                <Labeled label="Accent prob.">
                  <input type="number" min={0} max={0.8} step={0.01} value={accentProbability} onChange={(e)=>setAccentProbability(Number(e.target.value))} style={inputSmall} />
                </Labeled>
              </Row>
            </div>

            <div>
              <h3 style={h3}>音域・声色</h3>
              <Row>
                <Labeled label="Lead octave">
                  <input type="number" min={2} max={6} value={leadOctave} onChange={(e)=>setLeadOctave(Number(e.target.value))} style={inputSmall} />
                </Labeled>
                <Labeled label="Range (octaves)">
                  <input type="number" min={1} max={4} value={rangeOctaves} onChange={(e)=>setRangeOctaves(Number(e.target.value))} style={inputSmall} />
                </Labeled>
              </Row>

              <Labeled label="Voice preset">
                <select value={voicePreset} onChange={(e)=>setVoicePreset(e.target.value)} style={input}>
                  <option value="choir">Choir</option>
                  <option value="soft">Soft</option>
                  <option value="bright">Bright</option>
                  <option value="robot">Robot</option>
                </select>
              </Labeled>

              <h3 style={h3}>生成プレビュー</h3>
              {project && (
                <>
                  <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 6 }}>
                    Chords: <b>{project.chordProg.join(" - ")}</b>
                  </div>
                  <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, maxHeight: 260, overflow: "auto", background: "#fff" }}>
                    {project.events.slice(0, 200).map((e, idx) => (
                      <div key={idx} style={{ display: "grid", gridTemplateColumns: "70px 70px 1fr 90px", gap: 8, fontSize: 12, padding: "3px 0", borderBottom: "1px dashed #f2f2f2" }}>
                        <span style={{ opacity: 0.7 }}>{e.tBeat.toFixed(2)}b</span>
                        <span style={{ opacity: 0.7 }}>{e.durBeats.toFixed(2)}b</span>
                        <span>{e.type === "note" ? e.lyric : "∅"}</span>
                        <span style={{ opacity: 0.85 }}>{e.type === "note" ? midiToNoteName(e.midi) : "rest"}</span>
                      </div>
                    ))}
                    {project.events.length > 200 && <div style={{ fontSize: 12, opacity: 0.6, paddingTop: 8 }}>… ({project.events.length} events)</div>}
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      )}

      {tab === "notation" && (
        <section style={card}>
          <h2 style={h2}>3) 楽譜（ABC）</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button onClick={exportAbc} style={btnPrimary}>ABCを保存</button>
              <button onClick={() => navigator.clipboard?.writeText(abc)} style={btn}>ABCをコピー</button>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <h3 style={h3}>ABCテキスト</h3>
                <textarea value={abc} readOnly rows={18} style={{ width: "100%", padding: 10, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, borderRadius: 10, border: "1px solid #ddd" }} />
              </div>
              <div>
                <h3 style={h3}>レンダリング（abcjs）</h3>
                <div ref={abcDivRef} style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, background: "#fff", minHeight: 320, overflow: "auto" }}>
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    ※ レンダリングはネットワークから abcjs を動的ロードします。表示されない場合はABCテキストをご利用ください。
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {tab === "export" && (
        <section style={card}>
          <h2 style={h2}>4) エクスポート</h2>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={exportJson} style={btnPrimary}>JSON</button>
            <button onClick={exportMidi} style={btnPrimary}>MIDI</button>
            <button onClick={exportAbc} style={btnPrimary}>ABC</button>
            <button onClick={exportWav} style={btn}>WAV（best-effort）</button>
          </div>

          <div style={{ marginTop: 12, fontSize: 12, opacity: 0.85, lineHeight: 1.5 }}>
            <ul>
              <li><b>MIDI</b>: DAW（GarageBand / Logic / Cubase 等）に読み込めます。音色は環境依存です。</li>
              <li><b>ABC</b>: テキスト楽譜です。外部ツールでPDF化やMusicXML変換に使えます。</li>
              <li><b>WAV</b>: ブラウザが OfflineAudioContext をサポートしていれば書き出せます。</li>
            </ul>
          </div>
        </section>
      )}

      {tab === "features" && (
        <section style={card}>
          <h2 style={h2}>“100機能ぐらい”について</h2>
          <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.6 }}>
            この App.js だけで「作曲・歌唱・楽譜・書き出し」を全部やるため、まずは<b>動くコア機能</b>を多めに実装し、残りは拡張候補として一覧にしています。
            「どのジャンルに寄せたいか（J-POP / 演歌 / ロック / EDM 等）」「伴奏が欲しいか（ドラム/ベース/コード）」が決まると、残りを優先順位つきで実装できます。
          </div>

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, background: "#fff" }}>
              <h3 style={h3}>実装済み</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {featureList.filter(f=>f.done).map((f, i)=>(
                  <li key={i} style={{ margin: "6px 0" }}>✅ {f.name}</li>
                ))}
              </ul>
            </div>
            <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, background: "#fff" }}>
              <h3 style={h3}>追加候補（未実装）</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {featureList.filter(f=>!f.done).map((f, i)=>(
                  <li key={i} style={{ margin: "6px 0" }}>🧩 {f.name}</li>
                ))}
              </ul>
              <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                ここから“100個”に増やすときは、伴奏・編集UI・歌声API連携を中心に増やすのが効果的です。
              </div>
            </div>
          </div>
        </section>
      )}

      <footer style={{ marginTop: 14, fontSize: 12, opacity: 0.7 }}>
        Tips: 生成が気に入ったら <b>Seed</b> を固定し、BPM・Scale・Complexity を少しずつ動かすと狙った雰囲気に寄せやすいです。
      </footer>
    </div>
  );
}

// ----- Small UI atoms -----
function TabButton({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      padding: "8px 12px",
      borderRadius: 999,
      border: "1px solid #ddd",
      background: active ? "#111" : "#fff",
      color: active ? "#fff" : "#111",
      cursor: "pointer"
    }}>
      {label}
    </button>
  );
}

function Labeled({ label, children }) {
  return (
    <label style={{ display: "grid", gap: 6, marginBottom: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.75 }}>{label}</div>
      {children}
    </label>
  );
}

function Row({ children }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
      {children}
    </div>
  );
}

const btn = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid #ddd",
  background: "#fff",
  cursor: "pointer"
};

const btnPrimary = {
  ...btn,
  background: "#111",
  color: "#fff",
  border: "1px solid #111"
};

const input = {
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid #ddd",
  width: "100%",
};

const inputSmall = {
  ...input,
  width: 90
};

const card = {
  marginTop: 12,
  padding: 14,
  border: "1px solid #eee",
  borderRadius: 16,
  background: "#fafafa"
};

const h2 = { margin: "0 0 10px 0", fontSize: 16 };
const h3 = { margin: "10px 0 8px 0", fontSize: 14, opacity: 0.9 };
