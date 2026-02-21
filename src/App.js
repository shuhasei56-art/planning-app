// App.js
// A single-file React prototype for a "Lyrics -> Song" generator.
// Features included:
// - Lyrics editor + tokenizer
// - Local melody generator (works offline, no keys)
// - Optional AI song-structure generator via backend proxy (/api/generate-song)
// - Optional AI voice (TTS) via backend proxy (/api/tts) using OpenAI Audio API
// - Playback with Tone.js
// - Notation rendering with VexFlow
// - MIDI export via @tonejs/midi
// - WAV export via OfflineAudioContext render
//
// IMPORTANT:
// 1) Do NOT put your OpenAI API key in the browser. Use a server proxy.
// 2) "Singing" is approximated by a synth following melody + (optional) TTS overlay.
//    True singing voice modeling is out of scope for a browser-only demo.
//
// Install deps (example):
//   npm i tone vexflow @tonejs/midi
//
// Optional UI deps (nice to have):
//   npm i clsx
//
// Backend (example endpoints expected):
//   POST /api/generate-song   { lyrics, settings } -> { tempo, key, timeSig, sections:[...], melody:[...], chords:[...] }
//   POST /api/tts            { text, voice, style } -> { audioUrl } OR { audioBase64, mime }
//
// You can wire those endpoints to OpenAI Audio API /v1/audio/speech (model gpt-4o-mini-tts).
// See OpenAI docs for latest model/params.

import React, { useEffect, useMemo, useRef, useState } from "react";
import * as Tone from "tone";
import { Midi } from "@tonejs/midi";
import { Factory, EasyScore, System } from "vexflow";

// -------------------------------
// Utility
// -------------------------------
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const KEY_PRESETS = [
  { name: "C Major", tonic: "C", mode: "major" },
  { name: "G Major", tonic: "G", mode: "major" },
  { name: "D Major", tonic: "D", mode: "major" },
  { name: "A Minor", tonic: "A", mode: "minor" },
  { name: "E Minor", tonic: "E", mode: "minor" },
  { name: "F Major", tonic: "F", mode: "major" },
  { name: "Bb Major", tonic: "Bb", mode: "major" },
];

const SCALE_STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // natural minor
};

function noteToMidi(note) {
  // note like "C4" "F#3" "Bb4"
  const m = /^([A-G])([b#]?)(-?\d+)$/.exec(note);
  if (!m) return 60;
  const letter = m[1];
  const acc = m[2];
  const oct = parseInt(m[3], 10);
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
  const accidental = acc === "#" ? 1 : acc === "b" ? -1 : 0;
  return (oct + 1) * 12 + base + accidental;
}
function midiToNote(n) {
  const oct = Math.floor(n / 12) - 1;
  const pc = ((n % 12) + 12) % 12;
  return `${NOTE_NAMES[pc]}${oct}`;
}
function transposeMidi(n, semis) {
  return clamp(n + semis, 0, 127);
}

function tokenizeLyrics(lyrics) {
  // Very simple tokenizer: split by whitespace and punctuation; keep line breaks.
  const lines = lyrics.split(/\r?\n/);
  return lines.map((line) => {
    const tokens = line
      .trim()
      .split(/[\s　]+/g)
      .filter(Boolean)
      .flatMap((w) => w.split(/([、。！？!?,.])/).filter(Boolean));
    return tokens;
  });
}

function estimateSyllablesJP(token) {
  // Heuristic: count kana-like chars; fallback to length.
  // This is NOT perfect Japanese syllabification. It's a usable approximation.
  const kana = token.match(/[ぁ-んァ-ンー]/g);
  if (kana && kana.length) return kana.length;
  const latin = token.match(/[a-zA-Z]/g);
  if (latin && latin.length) return Math.max(1, Math.ceil(latin.length / 3));
  return Math.max(1, Math.ceil(token.length / 2));
}

function buildScale(tonic = "C", mode = "major", octave = 4) {
  // returns midi pitch classes in one octave as MIDI notes around octave
  // tonic like "C" "Bb" "F#"
  const m = /^([A-G])([b#]?)$/.exec(tonic);
  if (!m) tonic = "C";
  const letter = m ? m[1] : "C";
  const acc = m ? m[2] : "";
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[letter];
  const accidental = acc === "#" ? 1 : acc === "b" ? -1 : 0;
  const tonicPc = (base + accidental + 12) % 12;
  const steps = SCALE_STEPS[mode] || SCALE_STEPS.major;
  const rootMidi = (octave + 1) * 12 + tonicPc;
  return steps.map((s) => rootMidi + s);
}

// -------------------------------
// Local melody generator
// -------------------------------
function localGenerateSong({ lyrics, settings }) {
  const {
    tempo = 110,
    swing = 0,
    keyTonic = "C",
    keyMode = "major",
    timeSig = "4/4",
    complexity = 0.55,
    range = 12,
    seed = 1,
  } = settings;

  // Simple seeded RNG for repeatability
  let s = Math.max(1, Math.floor(seed));
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const [beatsPerBar, beatUnit] = timeSig.split("/").map((x) => parseInt(x, 10));
  const beatSeconds = 60 / tempo;
  const stepDur = beatSeconds * (4 / beatUnit) * 0.5; // eighth-notes default
  const maxBars = 16 + Math.floor(complexity * 32);

  const scale = buildScale(keyTonic, keyMode, 4);
  const center = noteToMidi(`${keyTonic.replace("Bb", "A#")}4`);
  const low = center - Math.floor(range / 2);
  const high = center + Math.floor(range / 2);

  const lines = tokenizeLyrics(lyrics);
  const melody = [];
  const sections = [];
  let t = 0;
  let bar = 0;

  const sectionPlan = [
    { name: "Intro", bars: 2 },
    { name: "Verse", bars: 4 },
    { name: "Chorus", bars: 4 },
    { name: "Verse2", bars: 4 },
    { name: "Chorus2", bars: 4 },
    { name: "Bridge", bars: 2 + Math.floor(complexity * 2) },
    { name: "Final Chorus", bars: 4 },
    { name: "Outro", bars: 2 },
  ];

  const plan = [];
  let total = 0;
  for (const p of sectionPlan) {
    if (total + p.bars > maxBars) break;
    plan.push(p);
    total += p.bars;
  }

  const chords = [];
  const chordPoolMajor = ["I", "V", "vi", "IV", "ii", "V", "I", "I"];
  const chordPoolMinor = ["i", "VII", "VI", "VII", "i", "iv", "V", "i"];

  for (const sec of plan) {
    sections.push({ id: uid(), name: sec.name, startBar: bar, bars: sec.bars });
    for (let b = 0; b < sec.bars; b++) {
      const deg = keyMode === "minor" ? chordPoolMinor[(bar + b) % chordPoolMinor.length] : chordPoolMajor[(bar + b) % chordPoolMajor.length];
      chords.push({ bar: bar + b, symbol: deg });
    }
    bar += sec.bars;
  }

  // Map lyrics tokens onto steps with rhythmic variation
  const allTokens = lines.flat();
  const totalSteps = total * beatsPerBar * 2; // eighth-note grid
  const tokens = allTokens.length ? allTokens : ["la"];
  const tokenToStep = totalSteps / tokens.length;

  let prevMidi = center;
  for (let i = 0; i < tokens.length && i < totalSteps; i++) {
    const token = tokens[i];
    const syl = estimateSyllablesJP(token);
    const durStepsBase = clamp(Math.round((syl * (0.6 + complexity)) * 0.8), 1, 8);
    const jitter = (rnd() - 0.5) * complexity * 4;
    const durSteps = clamp(durStepsBase + Math.round(jitter), 1, 8);

    // Choose a scale degree near previous, with occasional leaps at higher complexity
    const leapChance = 0.08 + 0.35 * complexity;
    const leap = rnd() < leapChance ? (rnd() < 0.5 ? -5 : 5) : (rnd() < 0.5 ? -2 : 2);
    const nearestScale = (m) => {
      let best = scale[0];
      let bestD = Infinity;
      for (let k = -2; k <= 2; k++) {
        for (const p of scale) {
          const cand = p + 12 * k;
          const d = Math.abs(cand - m);
          if (d < bestD) {
            bestD = d;
            best = cand;
          }
        }
      }
      return best;
    };

    const target = clamp(prevMidi + leap + Math.round((rnd() - 0.5) * complexity * 6), low, high);
    let midi = nearestScale(target);

    // add ornament at high complexity (grace-like short note)
    const addOrn = complexity > 0.6 && rnd() < (complexity - 0.55);
    if (addOrn) {
      const ornMidi = nearestScale(clamp(midi + (rnd() < 0.5 ? -2 : 2), low, high));
      melody.push({
        t,
        dur: stepDur * 0.5,
        midi: ornMidi,
        lyric: "",
        type: "ornament",
        vel: 0.5,
      });
      t += stepDur * 0.5;
    }

    melody.push({
      t,
      dur: stepDur * durSteps,
      midi,
      lyric: token,
      type: "note",
      vel: 0.75,
    });

    // swing: delay every other eighth at playback time; keep data grid simple
    t += stepDur * durSteps;
    prevMidi = midi;
  }

  return {
    tempo,
    key: { tonic: keyTonic, mode: keyMode },
    timeSig,
    swing,
    sections,
    chords,
    melody,
  };
}

// -------------------------------
// Notation rendering (VexFlow)
// -------------------------------
function renderNotation(containerEl, song) {
  if (!containerEl) return;
  containerEl.innerHTML = "";

  const width = containerEl.clientWidth ? containerEl.clientWidth : 900;
  const vf = new Factory({ renderer: { elementId: containerEl, width, height: 260 } });
  const score = vf.EasyScore();
  const system = vf.System({ x: 10, y: 20, width: width - 20, spaceBetweenStaves: 10 });

  const beats = parseInt(song.timeSig.split("/")[0], 10);
  const beatUnit = parseInt(song.timeSig.split("/")[1], 10);

  // Convert a subset of melody to notation-friendly durations
  // We'll render first ~4 bars for simplicity in this prototype.
  const beatSeconds = 60 / song.tempo;
  const barSeconds = beatSeconds * beats * (4 / beatUnit);

  const start = 0;
  const end = barSeconds * 4;
  const notes = song.melody.filter((n) => n.t >= start && n.t < end && n.type === "note");

  // map seconds to quantized durations (8th / 16th)
  const quant = (sec) => {
    const q = beatSeconds * 0.5; // 8th note
    return Math.max(1, Math.round(sec / q));
  };

  const vexDur = (steps) => {
    // steps are 8th-note units; convert to vexflow duration strings (approx)
    if (steps <= 1) return "8";
    if (steps === 2) return "q";
    if (steps === 3) return "q."; // dotted quarter
    if (steps === 4) return "h";
    if (steps === 6) return "h."; // dotted half
    if (steps >= 8) return "w";
    return "q";
  };

  const staveNotes = [];
  for (const n of notes) {
    const steps = quant(n.dur);
    const dur = vexDur(steps);
    const note = midiToNote(n.midi).replace("B#", "C").replace("E#", "F"); // normalize a bit
    // VexFlow expects lowercase note names and octave like "c/4"
    const m = /^([A-G])(#?)(\d)$/.exec(note);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const acc = m[2];
    const oct = m[3];
    const key = `${name}${acc ? acc : ""}/${oct}`;
    staveNotes.push({ key, dur, lyric: n.lyric });
    if (staveNotes.length > 24) break;
  }

  const voice = score.voice(
    staveNotes.map((n) => `${n.key}/${n.dur}`).join(", "),
    { time: song.timeSig }
  );

  system
    .addStave({
      voices: [voice],
    })
    .addClef("treble")
    .addTimeSignature(song.timeSig)
    .addKeySignature(song.key.tonic);

  vf.draw();
}

// -------------------------------
// MIDI export
// -------------------------------
function songToMidi(song) {
  const midi = new Midi();
  midi.header.setTempo(song.tempo);
  const [beats] = song.timeSig.split("/").map((x) => parseInt(x, 10));
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [beats, 4] });

  const track = midi.addTrack();
  track.name = "Melody";

  // Use seconds -> ticks with 480ppq default
  const ppq = midi.header.ppq;
  const tempo = song.tempo;
  const secToTicks = (sec) => Math.round((sec * tempo * ppq) / 60);

  for (const n of song.melody) {
    if (n.type !== "note") continue;
    track.addNote({
      midi: n.midi,
      time: secToTicks(n.t) / ppq, // Midi lib uses "beats" by default when given number; but time is in seconds if header? safer use seconds? We'll keep beats:
      // Actually @tonejs/midi expects "time" in seconds if you set tempo? It's in seconds in docs examples.
      // We'll use seconds directly:
      time: n.t,
      duration: n.dur,
      velocity: clamp(n.vel, 0, 1),
    });
  }

  return midi;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function renderSongToWav(song, synthPreset = "basic") {
  // Render with OfflineAudioContext using Tone.Offline
  const duration = song.melody.length
    ? song.melody[song.melody.length - 1].t + song.melody[song.melody.length - 1].dur + 0.5
    : 5;

  const buffer = await Tone.Offline(async ({ transport }) => {
    const synth =
      synthPreset === "vocal"
        ? new Tone.FormantSynth().toDestination()
        : new Tone.PolySynth(Tone.Synth).toDestination();

    transport.bpm.value = song.tempo;

    for (const n of song.melody) {
      if (n.type !== "note") continue;
      const freq = Tone.Frequency(n.midi, "midi");
      synth.triggerAttackRelease(freq, n.dur, n.t, clamp(n.vel, 0, 1));
    }

    transport.start(0);
  }, duration);

  // Convert AudioBuffer to WAV (minimal)
  const wav = audioBufferToWav(buffer.get());
  return new Blob([wav], { type: "audio/wav" });
}

function audioBufferToWav(audioBuffer) {
  const numCh = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  let interleaved;
  if (numCh === 2) {
    const l = audioBuffer.getChannelData(0);
    const r = audioBuffer.getChannelData(1);
    interleaved = interleave(l, r);
  } else {
    interleaved = audioBuffer.getChannelData(0);
  }

  const byteRate = (sampleRate * numCh * bitDepth) / 8;
  const blockAlign = (numCh * bitDepth) / 8;
  const buffer = new ArrayBuffer(44 + interleaved.length * 2);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + interleaved.length * 2, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, "data");
  view.setUint32(40, interleaved.length * 2, true);

  floatTo16BitPCM(view, 44, interleaved);
  return buffer;

  function writeString(view, offset, str) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }
  function interleave(inputL, inputR) {
    const length = inputL.length + inputR.length;
    const result = new Float32Array(length);
    let index = 0;
    let inputIndex = 0;
    while (index < length) {
      result[index++] = inputL[inputIndex];
      result[index++] = inputR[inputIndex];
      inputIndex++;
    }
    return result;
  }
  function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      const s = clamp(input[i], -1, 1);
      output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }
}

// -------------------------------
// Backend helpers (optional)
// -------------------------------
async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText} ${text}`.trim());
  }
  return res.json();
}

// -------------------------------
// "100 features" toggles (stubs)
// -------------------------------
const FEATURE_STUBS = [
  // Composition & structure
  "Song sections (Intro/Verse/Chorus/Bridge/Outro)",
  "Multiple choruses + key change",
  "Tempo map (rit./accel.)",
  "Swing / groove templates",
  "Polyrhythms (3:2 / 5:4)",
  "Odd meters (5/4, 7/8, 11/8)",
  "Syncopation intensity",
  "Humanize timing/velocity",
  "Call-and-response backing vocals",
  "Counter-melody generator",
  // Harmony
  "Chord progression generator",
  "Secondary dominants",
  "Modal interchange",
  "Borrowed chords",
  "Jazz reharmonization",
  "Voice leading optimization",
  "Bassline generator",
  "Arpeggiator",
  "Pad / strings arrangement",
  "Guitar strumming patterns",
  // Sound & mix
  "Instrument presets",
  "Reverb / delay",
  "Sidechain pumping",
  "EQ presets",
  "Compressor presets",
  "Limiter on master",
  "Stereo width control",
  "Auto-pan",
  "Lo-fi vinyl effect",
  "Tape saturation",
  // Lyrics & vocals
  "Lyric syllable alignment",
  "Rhyme suggestions",
  "Alliteration suggestions",
  "Japanese mora-aware spacing",
  "Pitch contour from sentiment",
  "Vibrato control (synth)",
  "Breath/noise layer",
  "TTS voice selector",
  "TTS style instructions",
  "Pronunciation hints",
  // Output
  "MIDI export",
  "WAV export",
  "MusicXML export (stub)",
  "PDF score export (stub)",
  "Chord chart export",
  "Lyrics + timestamps (LRC)",
  "Stems export (stub)",
  "Loop export",
  "A/B versions",
  "Version history (local)",
  // UX
  "Undo/redo",
  "Autosave",
  "Templates (genre presets)",
  "Random seed lock",
  "Share link (stub)",
  "Keyboard shortcuts",
  "Dark mode",
  "Metronome",
  "Count-in",
  "Loop playback",
  // AI / advanced
  "AI song blueprint (JSON)",
  "AI melody refinement",
  "AI chord reharm",
  "AI arrangement",
  "AI mixing notes",
  "AI cover art (stub)",
  "AI title generator",
  "AI genre classifier",
  "AI vocal coach tips",
  "Realtime voice agent (stub)",
  // More stubs to approach ~100
  "Scale selection",
  "Key detection (from melody)",
  "Drum pattern generator",
  "Hi-hat groove control",
  "Fill generator",
  "Breakdowns",
  "Drop builder",
  "EDM risers",
  "Orchestration presets",
  "Chord extensions",
  "Strum velocity",
  "Fingerstyle patterns",
  "Piano voicings",
  "Brass stabs",
  "Synth lead glide",
  "Portamento",
  "Microtiming per instrument",
  "Probability-based motifs",
  "Theme development",
  "Motif repetition control",
  "Melody contour options",
  "Range limits per voice",
  "Key change at final chorus",
  "Modulation options",
  "Lyric-to-mood mapping",
  "Emotion curve over sections",
  "Dynamic curve automation",
  "Automation lanes UI (stub)",
  "Spectrogram view (stub)",
  "MIDI import (stub)",
  "Drag/drop notes (stub)",
  "Piano roll editor (stub)",
  "Quantize grid selector",
  "Triplet grid",
  "Tuplet support (stub)",
  "Chord detector (stub)",
  "Lyrics karaoke view",
  "BPM tapper",
  "Click track export",
  "Project export/import (JSON)",
  "Cloud sync (stub)",
  "Collaboration (stub)",
  "Plugin hosting (stub)",
  "Custom instrument sampler (stub)",
  "IR reverb loader (stub)",
  "Pitch correction (stub)",
  "Formant shifting (stub)",
  "Multi-language lyrics",
  "Romanization helper",
  "Furigana helper",
  "User dictionaries",
  "Per-word stress (EN) (stub)",
  "Per-mora accents (JP) (stub)",
  "TTS caching",
  "Offline mode",
  "Progressive rendering",
  "Error reporting",
  "Telemetry (opt-in)",
  "Accessibility: ARIA labels",
  "Accessibility: font scaling",
  "Localization (i18n) (stub)",
];

// -------------------------------
// App
// -------------------------------
export default function App() {
  const [lyrics, setLyrics] = useState("風吹けば 夢が揺れて\n君の声が 夜を照らす\n");
  const [useAI, setUseAI] = useState(false);
  const [useTTS, setUseTTS] = useState(false);
  const [voice, setVoice] = useState("marin");
  const [ttsStyle, setTtsStyle] = useState("Sing gently, clear consonants, Japanese lyrics.");
  const [tempo, setTempo] = useState(110);
  const [timeSig, setTimeSig] = useState("4/4");
  const [keyPreset, setKeyPreset] = useState(KEY_PRESETS[0].name);
  const [complexity, setComplexity] = useState(0.6);
  const [swing, setSwing] = useState(0.1);
  const [range, setRange] = useState(14);
  const [seed, setSeed] = useState(42);
  const [status, setStatus] = useState("");
  const [song, setSong] = useState(() =>
    localGenerateSong({
      lyrics: "風吹けば 夢が揺れて\n君の声が 夜を照らす\n",
      settings: { tempo: 110, timeSig: "4/4", keyTonic: "C", keyMode: "major", complexity: 0.6, swing: 0.1, range: 14, seed: 42 },
    })
  );

  const [isPlaying, setIsPlaying] = useState(false);
  const synthRef = useRef(null);
  const partRef = useRef(null);
  const ttsAudioRef = useRef(null);
  const notationRef = useRef(null);

  const selectedKey = useMemo(() => KEY_PRESETS.find((k) => k.name === keyPreset) || KEY_PRESETS[0], [keyPreset]);

  // Render notation when song changes
  useEffect(() => {
    try {
      renderNotation(notationRef.current, song);
    } catch (e) {
      // ignore
    }
  }, [song]);

  // Initialize synth once
  useEffect(() => {
    synthRef.current = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.01, decay: 0.1, sustain: 0.3, release: 0.25 },
    }).toDestination();

    return () => {
      try {
        synthRef.current?.dispose?.();
      } catch {}
    };
  }, []);

  const stop = async () => {
    try {
      Tone.Transport.stop();
      Tone.Transport.cancel(0);
      partRef.current?.dispose?.();
      partRef.current = null;
      setIsPlaying(false);
      if (ttsAudioRef.current) {
        ttsAudioRef.current.pause();
        ttsAudioRef.current.currentTime = 0;
      }
    } catch {}
  };

  const schedulePlayback = async (theSong) => {
    await Tone.start();
    await stop();

    Tone.Transport.bpm.value = theSong.tempo;

    // Swing: Tone has swing based on 8th-notes
    Tone.Transport.swing = clamp(theSong.swing, 0, 1);
    Tone.Transport.swingSubdivision = "8n";

    const events = theSong.melody
      .filter((n) => n.type === "note")
      .map((n) => ({
        time: n.t,
        midi: n.midi,
        dur: n.dur,
        vel: clamp(n.vel ?? 0.8, 0, 1),
      }));

    const synth = synthRef.current;
    const part = new Tone.Part((time, value) => {
      const freq = Tone.Frequency(value.midi, "midi");
      synth.triggerAttackRelease(freq, value.dur, time, value.vel);
    }, events);

    part.start(0);
    partRef.current = part;

    // Optional TTS overlay (not pitched singing; it's speech / "sing-like" prompt)
    if (useTTS) {
      try {
        setStatus("TTS生成中…");
        const tts = await postJson("/api/tts", { text: lyrics, voice, style: ttsStyle });
        const audio = new Audio();
        if (tts.audioUrl) {
          audio.src = tts.audioUrl;
        } else if (tts.audioBase64 && tts.mime) {
          audio.src = `data:${tts.mime};base64,${tts.audioBase64}`;
        } else {
          throw new Error("Invalid /api/tts response");
        }
        ttsAudioRef.current = audio;
        // start roughly together with transport
        audio.currentTime = 0;
        audio.play().catch(() => {});
        setStatus("");
      } catch (e) {
        setStatus(`TTS失敗: ${e.message}`);
      }
    }

    Tone.Transport.start("+0.05");
    setIsPlaying(true);
  };

  const generate = async () => {
    setStatus("生成中…");
    try {
      const settings = {
        tempo,
        timeSig,
        keyTonic: selectedKey.tonic,
        keyMode: selectedKey.mode,
        complexity,
        swing,
        range,
        seed,
      };

      let nextSong = null;

      if (useAI) {
        // Expect a backend that returns a full blueprint
        nextSong = await postJson("/api/generate-song", { lyrics, settings });
        // minimal validation fallback
        if (!nextSong?.melody?.length) nextSong = localGenerateSong({ lyrics, settings });
      } else {
        nextSong = localGenerateSong({ lyrics, settings });
      }

      setSong(nextSong);
      setStatus("生成完了");
      setTimeout(() => setStatus(""), 900);
    } catch (e) {
      setStatus(`生成失敗: ${e.message}`);
    }
  };

  const play = async () => {
    await schedulePlayback(song);
  };

  const exportMidi = () => {
    try {
      const midi = songToMidi(song);
      const bytes = midi.toArray();
      downloadBlob(new Blob([bytes], { type: "audio/midi" }), "song.mid");
    } catch (e) {
      setStatus(`MIDI出力失敗: ${e.message}`);
    }
  };

  const exportWav = async () => {
    try {
      setStatus("WAVレンダリング中…");
      const wavBlob = await renderSongToWav(song, "vocal");
      downloadBlob(wavBlob, "song.wav");
      setStatus("");
    } catch (e) {
      setStatus(`WAV出力失敗: ${e.message}`);
    }
  };

  const copySongJson = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(song, null, 2));
      setStatus("JSONをコピーしました");
      setTimeout(() => setStatus(""), 900);
    } catch (e) {
      setStatus("コピー失敗");
    }
  };

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", padding: 16, maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ margin: "8px 0 4px" }}>Lyrics → Rhythm Song Maker</h1>
      <p style={{ margin: "0 0 16px", opacity: 0.8 }}>
        歌詞を入れると「メロディ・リズム・簡易伴奏」を生成して再生します。楽譜（簡易）とMIDI/WAV書き出しもできます。
        <br />
        ※ブラウザだけで「AIが歌う」品質に到達するのは難しいため、このデモでは <b>合成音(メロディ)</b> + <b>TTS音声</b> の重ね合わせで近い体験を作ります。
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1.1fr 0.9fr", gap: 12 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
          <h2 style={{ marginTop: 0 }}>歌詞</h2>
          <textarea
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            rows={10}
            style={{ width: "100%", resize: "vertical", fontSize: 14, padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
            placeholder="ここに歌詞を入力…"
          />

          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            <button onClick={generate} style={btnStyle}>
              生成
            </button>
            <button onClick={isPlaying ? stop : play} style={btnStyle}>
              {isPlaying ? "停止" : "再生"}
            </button>
            <button onClick={exportMidi} style={btnStyle}>
              MIDI出力
            </button>
            <button onClick={exportWav} style={btnStyle}>
              WAV出力
            </button>
            <button onClick={copySongJson} style={btnStyle}>
              JSONコピー
            </button>
            <button
              onClick={() => {
                setSeed((s) => s + 1);
                setTimeout(generate, 0);
              }}
              style={btnStyle}
            >
              ランダム
            </button>
          </div>

          {status ? <div style={{ marginTop: 10, color: status.includes("失敗") ? "crimson" : "#333" }}>{status}</div> : null}

          <div style={{ marginTop: 14 }}>
            <h3 style={{ margin: "10px 0 6px" }}>楽譜（先頭4小節の簡易表示）</h3>
            <div
              ref={notationRef}
              id="notation"
              style={{ border: "1px solid #eee", borderRadius: 12, padding: 8, overflowX: "auto" }}
            />
          </div>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
          <h2 style={{ marginTop: 0 }}>設定</h2>

          <Row label="AIで複雑生成（要バックエンド）">
            <input type="checkbox" checked={useAI} onChange={(e) => setUseAI(e.target.checked)} />
          </Row>

          <Row label="AIボイス（TTS）を重ねる（要バックエンド）">
            <input type="checkbox" checked={useTTS} onChange={(e) => setUseTTS(e.target.checked)} />
          </Row>

          <Row label="TTS Voice">
            <select value={voice} onChange={(e) => setVoice(e.target.value)} style={selectStyle}>
              {["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"].map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </Row>

          <Row label="TTS Style Prompt">
            <textarea
              value={ttsStyle}
              onChange={(e) => setTtsStyle(e.target.value)}
              rows={3}
              style={{ width: "100%", resize: "vertical", fontSize: 12, padding: 8, borderRadius: 10, border: "1px solid #ccc" }}
            />
          </Row>

          <Row label={`Tempo: ${tempo} BPM`}>
            <input type="range" min={60} max={200} value={tempo} onChange={(e) => setTempo(parseInt(e.target.value, 10))} style={{ width: "100%" }} />
          </Row>

          <Row label={`Complexity: ${Math.round(complexity * 100)}%`}>
            <input type="range" min={0} max={1} step={0.01} value={complexity} onChange={(e) => setComplexity(parseFloat(e.target.value))} style={{ width: "100%" }} />
          </Row>

          <Row label={`Swing: ${Math.round(swing * 100)}%`}>
            <input type="range" min={0} max={1} step={0.01} value={swing} onChange={(e) => setSwing(parseFloat(e.target.value))} style={{ width: "100%" }} />
          </Row>

          <Row label={`Range: ${range} semitones`}>
            <input type="range" min={6} max={24} value={range} onChange={(e) => setRange(parseInt(e.target.value, 10))} style={{ width: "100%" }} />
          </Row>

          <Row label="Time Signature">
            <select value={timeSig} onChange={(e) => setTimeSig(e.target.value)} style={selectStyle}>
              {["4/4", "3/4", "6/8", "5/4", "7/8"].map((ts) => (
                <option key={ts} value={ts}>
                  {ts}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Key">
            <select value={keyPreset} onChange={(e) => setKeyPreset(e.target.value)} style={selectStyle}>
              {KEY_PRESETS.map((k) => (
                <option key={k.name} value={k.name}>
                  {k.name}
                </option>
              ))}
            </select>
          </Row>

          <Row label="Seed">
            <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || "1", 10))} style={inputStyle} />
          </Row>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer" }}>「機能100個」追加用のスタブ一覧（ON/OFF UIなし）</summary>
            <ul>
              {FEATURE_STUBS.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          </details>

          <details style={{ marginTop: 10 }}>
            <summary style={{ cursor: "pointer" }}>バックエンド実装のヒント（要サーバ）</summary>
            <div style={{ marginTop: 8, fontSize: 13, lineHeight: 1.5, opacity: 0.9 }}>
              <p style={{ marginTop: 0 }}>
                <b>/api/tts</b> は OpenAI Audio API の <code>/v1/audio/speech</code> を叩くプロキシにします（ブラウザにAPIキーを置かない）。
                返り値は <code>audioUrl</code> または <code>audioBase64</code> でOK。
              </p>
              <p>
                <b>/api/generate-song</b> は「歌詞と設定 → JSONで構成/メロディ/コード」を返すようにします。JSONスキーマを厳密にして、モデルに守らせると安定します。
              </p>
              <p style={{ marginBottom: 0 }}>
                このApp.jsはフロントだけでも動きます（ローカル生成）。AIを足すと「より複雑な構成」「音域・跳躍・反復テーマ」「セクション別の抑揚」などを強化できます。
              </p>
            </div>
          </details>
        </div>
      </div>

      <div style={{ marginTop: 14, border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
        <h2 style={{ marginTop: 0 }}>生成データ（概要）</h2>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <h3 style={{ margin: "6px 0" }}>Sections</h3>
            <ol style={{ marginTop: 6 }}>
              {song.sections?.map((s) => (
                <li key={s.id}>
                  {s.name} — startBar {s.startBar}, bars {s.bars}
                </li>
              ))}
            </ol>
          </div>
          <div>
            <h3 style={{ margin: "6px 0" }}>Chords (by bar)</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
              {song.chords?.slice(0, 32).map((c, i) => (
                <span key={i} style={{ border: "1px solid #ddd", borderRadius: 999, padding: "4px 10px", fontSize: 12 }}>
                  {c.bar + 1}: {c.symbol}
                </span>
              ))}
            </div>
            {song.chords?.length > 32 ? <div style={{ marginTop: 8, opacity: 0.7 }}>…</div> : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, alignItems: "center", margin: "10px 0" }}>
      <div style={{ fontSize: 13, opacity: 0.9 }}>{label}</div>
      <div>{children}</div>
    </div>
  );
}

const btnStyle = {
  padding: "8px 12px",
  borderRadius: 10,
  border: "1px solid #ccc",
  background: "white",
  cursor: "pointer",
};

const selectStyle = { width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc" };
const inputStyle = { width: "100%", padding: "8px 10px", borderRadius: 10, border: "1px solid #ccc" };
