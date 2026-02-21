// App.js
// ✅ Dependency-free (React only) single-file prototype.
// - No Tone.js / VexFlow / @tonejs/midi imports
// - Uses Web Audio API for playback (simple "sing-like" synth)
// - Generates rhythm + melody from lyrics (JP-friendly heuristic)
// - Provides:
//   * Play/Stop
//   * Tempo / Key / TimeSig / Complexity / Swing / Range / Seed
//   * "Score" preview as lightweight text staff (ASCII-ish)
//   * Export: MIDI (Standard MIDI File) generated in pure JS
//   * Export: JSON project
//
// Notes:
// - "AIが歌う" を本格的にやるにはサーバ側のTTS/歌声合成が必要ですが、
//   App.js単体で完結する範囲として「歌うような合成音（ピッチ＋母音っぽいフィルタ）」を実装しています。
// - CRA / Vite どちらでも動く想定（追加依存なし）。
//
// If your build previously failed because of missing 'tone', this file fixes it.

import React, { useEffect, useMemo, useRef, useState } from "react";

// -------------------------------
// Utilities
// -------------------------------
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

const KEY_PRESETS = [
  { name: "C Major", tonic: "C", mode: "major" },
  { name: "G Major", tonic: "G", mode: "major" },
  { name: "D Major", tonic: "D", mode: "major" },
  { name: "F Major", tonic: "F", mode: "major" },
  { name: "Bb Major", tonic: "Bb", mode: "major" },
  { name: "A Minor", tonic: "A", mode: "minor" },
  { name: "E Minor", tonic: "E", mode: "minor" },
];

const SCALE_STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10], // natural minor
};

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const PC_FROM_NAME = {
  C: 0,
  "C#": 1,
  Db: 1,
  D: 2,
  "D#": 3,
  Eb: 3,
  E: 4,
  F: 5,
  "F#": 6,
  Gb: 6,
  G: 7,
  "G#": 8,
  Ab: 8,
  A: 9,
  "A#": 10,
  Bb: 10,
  B: 11,
};

function midiToNoteName(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[pc]}${oct}`;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function tokenizeLyrics(lyrics) {
  const lines = lyrics.split(/\r?\n/);
  return lines.map((line) =>
    line
      .trim()
      .split(/[\s　]+/g)
      .filter(Boolean)
      .flatMap((w) => w.split(/([、。！？!?,.])/).filter(Boolean))
  );
}

function estimateSyllablesJP(token) {
  const kana = token.match(/[ぁ-んァ-ンー]/g);
  if (kana && kana.length) return kana.length;
  const latin = token.match(/[a-zA-Z]/g);
  if (latin && latin.length) return Math.max(1, Math.ceil(latin.length / 3));
  return Math.max(1, Math.ceil(token.length / 2));
}

function buildScaleMidi(tonic = "C", mode = "major", octave = 4) {
  const tonicPc = PC_FROM_NAME[tonic] ?? 0;
  const steps = SCALE_STEPS[mode] || SCALE_STEPS.major;
  const rootMidi = (octave + 1) * 12 + tonicPc;
  return steps.map((s) => rootMidi + s);
}

// Simple seeded RNG for repeatability
function makeRng(seed) {
  let s = Math.max(1, Math.floor(seed || 1)) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// -------------------------------
// Local song generator (offline)
// -------------------------------
function localGenerateSong({ lyrics, settings }) {
  const {
    tempo = 110,
    swing = 0.1,
    keyTonic = "C",
    keyMode = "major",
    timeSig = "4/4",
    complexity = 0.6,
    range = 14,
    seed = 42,
  } = settings;

  const rnd = makeRng(seed);

  const [beatsPerBar, beatUnit] = timeSig.split("/").map((x) => parseInt(x, 10));
  const beatSeconds = 60 / tempo;
  const eighthSeconds = beatSeconds * (4 / beatUnit) * 0.5; // 8th grid
  const maxBars = 16 + Math.floor(complexity * 32);

  const scale = buildScaleMidi(keyTonic, keyMode, 4);
  const center = (5 * 12) + (PC_FROM_NAME[keyTonic] ?? 0); // around octave 4-ish
  const low = center - Math.floor(range / 2);
  const high = center + Math.floor(range / 2);

  const lines = tokenizeLyrics(lyrics);
  const tokens = (lines.flat().length ? lines.flat() : ["la"]).slice(0, 999);

  // Section plan
  const basePlan = [
    { name: "Intro", bars: 2 },
    { name: "Verse", bars: 4 },
    { name: "Chorus", bars: 4 },
    { name: "Verse2", bars: 4 },
    { name: "Chorus2", bars: 4 },
    { name: "Bridge", bars: 2 + Math.floor(complexity * 2) },
    { name: "Final Chorus", bars: 4 },
    { name: "Outro", bars: 2 },
  ];

  const sections = [];
  const chords = [];
  const chordPoolMajor = ["I", "V", "vi", "IV", "ii", "V", "I", "I"];
  const chordPoolMinor = ["i", "VII", "VI", "VII", "i", "iv", "V", "i"];

  let bar = 0;
  let totalBars = 0;
  for (const p of basePlan) {
    if (totalBars + p.bars > maxBars) break;
    sections.push({ id: uid(), name: p.name, startBar: bar, bars: p.bars });
    for (let b = 0; b < p.bars; b++) {
      const sym = keyMode === "minor"
        ? chordPoolMinor[(bar + b) % chordPoolMinor.length]
        : chordPoolMajor[(bar + b) % chordPoolMajor.length];
      chords.push({ bar: bar + b, symbol: sym });
    }
    bar += p.bars;
    totalBars += p.bars;
  }

  const totalSteps = totalBars * beatsPerBar * 2; // 8th notes count
  const melody = [];

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

  let t = 0;
  let prev = center;
  let tokenIndex = 0;

  while (t < totalSteps * eighthSeconds && tokenIndex < tokens.length) {
    const token = tokens[tokenIndex++];
    const syl = estimateSyllablesJP(token);

    // Duration in 8th steps
    const baseSteps = clamp(Math.round(syl * (0.6 + complexity) * 0.7), 1, 8);
    const jitter = Math.round((rnd() - 0.5) * complexity * 4);
    const steps = clamp(baseSteps + jitter, 1, 8);

    const leapChance = 0.08 + 0.35 * complexity;
    const leap = rnd() < leapChance ? (rnd() < 0.5 ? -5 : 5) : (rnd() < 0.5 ? -2 : 2);
    const target = clamp(prev + leap + Math.round((rnd() - 0.5) * complexity * 6), low, high);
    const midi = nearestScale(target);

    // Ornament note at higher complexity
    const addOrn = complexity > 0.62 && rnd() < (complexity - 0.58);
    if (addOrn) {
      const orn = nearestScale(clamp(midi + (rnd() < 0.5 ? -2 : 2), low, high));
      melody.push({ t, dur: eighthSeconds * 0.5, midi: orn, lyric: "", type: "orn", vel: 0.5 });
      t += eighthSeconds * 0.5;
    }

    melody.push({ t, dur: eighthSeconds * steps, midi, lyric: token, type: "note", vel: 0.75 });
    t += eighthSeconds * steps;
    prev = midi;
  }

  return {
    tempo,
    key: { tonic: keyTonic, mode: keyMode },
    timeSig,
    swing,
    sections,
    chords,
    melody,
    createdAt: new Date().toISOString(),
  };
}

// -------------------------------
// Lightweight "Score" rendering (text)
// -------------------------------
function songToTextScore(song, barsToShow = 8) {
  const [beatsPerBar, beatUnit] = song.timeSig.split("/").map((x) => parseInt(x, 10));
  const beatSeconds = 60 / song.tempo;
  const eighthSeconds = beatSeconds * (4 / beatUnit) * 0.5;
  const totalEighths = barsToShow * beatsPerBar * 2;

  // Map events to 8th grid
  const grid = Array.from({ length: totalEighths }, () => null);
  for (const n of song.melody) {
    if (n.type !== "note") continue;
    const idx = Math.round(n.t / eighthSeconds);
    if (idx >= 0 && idx < grid.length) grid[idx] = n;
  }

  // Pitch visualization: map midi to vertical characters
  const minMidi = Math.min(...song.melody.filter(n=>n.type==="note").map(n=>n.midi), 60);
  const maxMidi = Math.max(...song.melody.filter(n=>n.type==="note").map(n=>n.midi), 72);
  const height = clamp(maxMidi - minMidi + 1, 8, 18);

  const lines = [];
  // Top header: bar markers
  let header = "      ";
  for (let i = 0; i < totalEighths; i++) {
    const isBar = i % (beatsPerBar * 2) === 0;
    header += isBar ? "|" : (i % 2 === 0 ? "." : " ");
  }
  lines.push(header);
  lines.push(`Key: ${song.key.tonic} ${song.key.mode}   Time: ${song.timeSig}   Tempo: ${song.tempo} BPM`);

  // Staff-ish graph
  const plot = Array.from({ length: height }, () => Array.from({ length: totalEighths }, () => " "));
  for (let i = 0; i < totalEighths; i++) {
    const n = grid[i];
    if (!n) continue;
    const y = clamp(maxMidi - n.midi, 0, height - 1);
    plot[y][i] = "●";
  }

  for (let y = 0; y < height; y++) {
    const midi = maxMidi - y;
    const label = midiToNoteName(midi).padEnd(5, " ");
    lines.push(label + " " + plot[y].join(""));
  }

  // Lyrics timeline
  let lyricLine = "Lyric ";
  for (let i = 0; i < totalEighths; i++) {
    const n = grid[i];
    if (!n || !n.lyric) {
      lyricLine += " ";
      continue;
    }
    // place a marker and keep actual lyrics below
    lyricLine += "^";
  }
  lines.push(lyricLine);

  const lyricWords = grid
    .map((n, i) => (n && n.lyric ? `${i.toString().padStart(3, "0")}:${n.lyric}` : null))
    .filter(Boolean)
    .slice(0, 120);

  if (lyricWords.length) {
    lines.push("Words: " + lyricWords.join("  "));
  }
  return lines.join("\n");
}

// -------------------------------
// WebAudio "sing-like" synth
// -------------------------------
function createSingerSynth(audioCtx) {
  // A simple vocal-ish chain:
  // Oscillator (saw) -> Gain (envelope) -> BiquadFilter (formant-ish) -> Compressor -> Destination
  const out = audioCtx.createGain();
  out.gain.value = 0.9;

  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 24;
  comp.ratio.value = 8;
  comp.attack.value = 0.003;
  comp.release.value = 0.25;

  const formant = audioCtx.createBiquadFilter();
  formant.type = "bandpass";
  formant.frequency.value = 900;
  formant.Q.value = 6;

  formant.connect(comp);
  comp.connect(out);

  const nodes = { out, formant, comp };

  function playNote({ midi, startTime, duration, velocity = 0.8, vibrato = 0.0 }) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = "sawtooth";
    const freq = midiToFreq(midi);

    // vibrato via detune LFO
    let lfo, lfoGain;
    if (vibrato > 0) {
      lfo = audioCtx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 6.0;
      lfoGain = audioCtx.createGain();
      lfoGain.gain.value = 12 * vibrato; // cents
      lfo.connect(lfoGain);
      lfoGain.connect(osc.detune);
      lfo.start(startTime);
      lfo.stop(startTime + duration + 0.1);
    }

    osc.frequency.setValueAtTime(freq, startTime);

    // Envelope
    const a = 0.02;
    const d = 0.08;
    const s = 0.5;
    const r = 0.12;
    const peak = clamp(velocity, 0, 1) * 0.45;

    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peak, startTime + a);
    gain.gain.exponentialRampToValueAtTime(peak * s, startTime + a + d);
    gain.gain.setValueAtTime(peak * s, startTime + Math.max(0, duration - r));
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);

    osc.connect(gain);
    gain.connect(nodes.formant);

    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
  }

  return { ...nodes, playNote };
}

// -------------------------------
// Pure JS MIDI Export (SMF Type 1, single track)
// -------------------------------
function writeVarLen(value) {
  // variable-length quantity
  let buffer = value & 0x7f;
  const bytes = [];
  while ((value >>= 7)) {
    buffer <<= 8;
    buffer |= (value & 0x7f) | 0x80;
  }
  while (true) {
    bytes.push(buffer & 0xff);
    if (buffer & 0x80) buffer >>= 8;
    else break;
  }
  return bytes;
}

function strBytes(s) {
  return Array.from(s).map((c) => c.charCodeAt(0) & 0xff);
}

function u16be(n) {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32be(n) {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function songToMidiBytes(song) {
  const ppq = 480;
  const tempo = song.tempo;
  const microPerQuarter = Math.round(60000000 / tempo);

  // Convert seconds to ticks
  const secToTicks = (sec) => Math.round((sec * tempo * ppq) / 60);

  // Build events (delta-time sorted)
  const events = [];

  // Meta: Tempo
  events.push({ t: 0, bytes: [0xff, 0x51, 0x03, (microPerQuarter >> 16) & 0xff, (microPerQuarter >> 8) & 0xff, microPerQuarter & 0xff] });

  // Meta: Time signature
  const [nn, dd] = song.timeSig.split("/").map((x) => parseInt(x, 10));
  const ddPow = Math.round(Math.log2(dd)); // 4->2, 8->3
  events.push({ t: 0, bytes: [0xff, 0x58, 0x04, nn & 0xff, ddPow & 0xff, 24, 8] });

  // Program change (lead)
  events.push({ t: 0, bytes: [0xc0, 0x52] }); // synth lead-ish

  for (const n of song.melody) {
    if (n.type !== "note") continue;
    const tOn = secToTicks(n.t);
    const tOff = secToTicks(n.t + n.dur);
    const vel = clamp(Math.round((n.vel ?? 0.75) * 127), 1, 127);

    events.push({ t: tOn, bytes: [0x90, n.midi & 0x7f, vel] }); // note on ch0
    events.push({ t: tOff, bytes: [0x80, n.midi & 0x7f, 0] }); // note off
  }

  // Sort by time, ensure note-offs first when same time
  events.sort((a, b) => (a.t - b.t) || ((a.bytes[0] & 0xf0) === 0x80 ? -1 : 1));

  // Track chunk data
  let lastT = 0;
  const trackData = [];
  for (const ev of events) {
    const delta = Math.max(0, ev.t - lastT);
    trackData.push(...writeVarLen(delta), ...ev.bytes);
    lastT = ev.t;
  }
  // End of track
  trackData.push(0x00, 0xff, 0x2f, 0x00);

  // Header chunk (MThd)
  const header = [
    ...strBytes("MThd"),
    ...u32be(6),
    ...u16be(1), // format 1
    ...u16be(1), // 1 track
    ...u16be(ppq),
  ];

  // Track chunk (MTrk)
  const track = [...strBytes("MTrk"), ...u32be(trackData.length), ...trackData];

  return new Uint8Array([...header, ...track]);
}

// -------------------------------
// Download helpers
// -------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

// -------------------------------
// Feature stubs list (~100)
// -------------------------------
const FEATURE_STUBS = [
  "Intro/Verse/Chorus/Bridge/Outro 自動構成",
  "複数コーラス + 終盤キー上げ",
  "テンポ変化（rit./accel.）",
  "スウィング/グルーヴテンプレ",
  "ポリリズム(3:2/5:4)スタブ",
  "変拍子(5/4,7/8,11/8)",
  "シンコペーション強度",
  "タイミング/ベロシティ人間味",
  "合いの手（掛け合い）スタブ",
  "対旋律（カウンターメロ）スタブ",
  "コード進行自動生成",
  "セカンダリードミナント スタブ",
  "モーダルインターチェンジ スタブ",
  "借用和音 スタブ",
  "ジャズ風リハモ スタブ",
  "ベースライン スタブ",
  "アルペジエータ スタブ",
  "パッド/ストリングス スタブ",
  "ギター・ストローク スタブ",
  "リバーブ/ディレイ スタブ",
  "サイドチェイン スタブ",
  "EQ/コンプ/リミッタ スタブ",
  "ステレオ幅/オートパン スタブ",
  "Lo-fi/Vinyl/Tape スタブ",
  "歌詞シラブル整列（簡易）",
  "韻・脚韻提案 スタブ",
  "オールiteration スタブ",
  "日本語モーラ対応 スタブ",
  "感情→ピッチ輪郭 スタブ",
  "ビブラート制御",
  "ブレス/ノイズ レイヤ スタブ",
  "TTS声選択（本格はサーバ）",
  "発音ヒント スタブ",
  "MIDI出力（実装済）",
  "MusicXML/PDF 譜面 スタブ",
  "コード譜出力 スタブ",
  "歌詞タイムスタンプ(LRC)スタブ",
  "ステム書き出し スタブ",
  "A/Bバージョン",
  "履歴（ローカル）スタブ",
  "テンプレ（ジャンル）スタブ",
  "シード固定/ランダム",
  "ショートカット スタブ",
  "ダークモード スタブ",
  "メトロノーム スタブ",
  "カウントイン スタブ",
  "ループ再生 スタブ",
  "MIDIインポート スタブ",
  "ピアノロール スタブ",
  "ドラッグで音符編集 スタブ",
  "クオンタイズグリッド",
  "3連符グリッド スタブ",
  "タプレット スタブ",
  "コード検出 スタブ",
  "カラオケ表示 スタブ",
  "BPMタップ",
  "プロジェクトJSON保存（実装済）",
  "クラウド同期 スタブ",
  "コラボ スタブ",
  "Sampler/IR Reverb スタブ",
  "ピッチ補正 スタブ",
  "フォルマントシフト スタブ",
  "多言語歌詞",
  "ローマ字/ふりがな スタブ",
  "ユーザー辞書 スタブ",
  "アクセシビリティ（ARIA）",
  "フォント拡大 スタブ",
  "i18n スタブ",
];

// -------------------------------
// App
// -------------------------------
export default function App() {
  const [lyrics, setLyrics] = useState("風吹けば 夢が揺れて\n君の声が 夜を照らす\n");
  const [tempo, setTempo] = useState(110);
  const [timeSig, setTimeSig] = useState("4/4");
  const [keyPreset, setKeyPreset] = useState(KEY_PRESETS[0].name);
  const [complexity, setComplexity] = useState(0.62);
  const [swing, setSwing] = useState(0.12);
  const [range, setRange] = useState(14);
  const [seed, setSeed] = useState(42);
  const [status, setStatus] = useState("");
  const [song, setSong] = useState(() =>
    localGenerateSong({
      lyrics: "風吹けば 夢が揺れて\n君の声が 夜を照らす\n",
      settings: { tempo: 110, timeSig: "4/4", keyTonic: "C", keyMode: "major", complexity: 0.62, swing: 0.12, range: 14, seed: 42 },
    })
  );

  const [isPlaying, setIsPlaying] = useState(false);

  const selectedKey = useMemo(() => KEY_PRESETS.find((k) => k.name === keyPreset) || KEY_PRESETS[0], [keyPreset]);

  // WebAudio refs
  const audioCtxRef = useRef(null);
  const stopRef = useRef({ stopAt: 0, timers: [] });

  useEffect(() => {
    return () => {
      // cleanup on unmount
      try {
        stopPlayback();
        audioCtxRef.current?.close?.();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generate = () => {
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
      const next = localGenerateSong({ lyrics, settings });
      setSong(next);
      setStatus("生成完了");
      setTimeout(() => setStatus(""), 900);
    } catch (e) {
      setStatus(`生成失敗: ${e.message}`);
    }
  };

  const ensureAudioCtx = async () => {
    if (!audioCtxRef.current) {
      const AC = window.AudioContext || window.webkitAudioContext;
      audioCtxRef.current = new AC();
    }
    if (audioCtxRef.current.state === "suspended") {
      await audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  };

  const stopPlayback = () => {
    try {
      const s = stopRef.current;
      s.stopAt = 0;
      if (s.timers?.length) {
        for (const id of s.timers) clearTimeout(id);
      }
      s.timers = [];
      setIsPlaying(false);
    } catch {}
  };

  const play = async () => {
    try {
      const ctx = await ensureAudioCtx();
      stopPlayback();

      const startAt = ctx.currentTime + 0.05;
      const singer = createSingerSynth(ctx);

      // master out
      const master = ctx.createGain();
      master.gain.value = 0.95;
      singer.out.connect(master);
      master.connect(ctx.destination);

      // Swing: delay odd eighths by swing amount (0..1 mapped to up to 40% of 8th)
      const [beatsPerBar, beatUnit] = song.timeSig.split("/").map((x) => parseInt(x, 10));
      const beatSeconds = 60 / song.tempo;
      const eighthSeconds = beatSeconds * (4 / beatUnit) * 0.5;
      const swingDelay = clamp(song.swing ?? 0, 0, 1) * eighthSeconds * 0.4;

      // "Vowel-ish" formant movement based on lyric (very rough)
      const setFormantFromText = (txt, at) => {
        const vowels = (txt || "").match(/[あいうえおアイウエオaeiou]/gi);
        const v = vowels && vowels.length ? vowels[0].toLowerCase() : "a";
        const map = {
          a: 900,
          i: 1200,
          u: 700,
          e: 1000,
          o: 800,
          "あ": 900,
          "い": 1200,
          "う": 700,
          "え": 1000,
          "お": 800,
          "ア": 900,
          "イ": 1200,
          "ウ": 700,
          "エ": 1000,
          "オ": 800,
        };
        const f = map[v] ?? 900;
        singer.formant.frequency.setTargetAtTime(f, at, 0.02);
      };

      for (const n of song.melody) {
        if (n.type !== "note") continue;

        // find eighth index to apply swing on odd
        const eighthIndex = Math.round(n.t / eighthSeconds);
        const isOdd = eighthIndex % 2 === 1;
        const t = startAt + n.t + (isOdd ? swingDelay : 0);

        setFormantFromText(n.lyric, t);

        const vibrato = 0.2 + clamp(song.swing ?? 0, 0, 1) * 0.15; // gentle vibrato
        singer.playNote({ midi: n.midi, startTime: t, duration: Math.max(0.03, n.dur * 0.98), velocity: n.vel ?? 0.75, vibrato });
      }

      const totalDur = song.melody.length ? song.melody[song.melody.length - 1].t + song.melody[song.melody.length - 1].dur : 2;
      setIsPlaying(true);

      const timerId = setTimeout(() => {
        stopPlayback();
      }, Math.ceil((totalDur + 0.2) * 1000));
      stopRef.current.timers.push(timerId);
    } catch (e) {
      setStatus(`再生失敗: ${e.message}`);
    }
  };

  const exportMidi = () => {
    try {
      const bytes = songToMidiBytes(song);
      downloadBlob(new Blob([bytes], { type: "audio/midi" }), "song.mid");
    } catch (e) {
      setStatus(`MIDI出力失敗: ${e.message}`);
    }
  };

  const exportJson = () => {
    try {
      downloadBlob(new Blob([JSON.stringify(song, null, 2)], { type: "application/json" }), "song.json");
    } catch (e) {
      setStatus(`JSON出力失敗: ${e.message}`);
    }
  };

  const copyScore = async () => {
    try {
      await navigator.clipboard.writeText(songToTextScore(song, 8));
      setStatus("譜面テキストをコピーしました");
      setTimeout(() => setStatus(""), 900);
    } catch {
      setStatus("コピー失敗（権限/HTTPSの可能性）");
    }
  };

  const scoreText = useMemo(() => songToTextScore(song, 8), [song]);

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif", padding: 16, maxWidth: 1150, margin: "0 auto" }}>
      <h1 style={{ margin: "8px 0 4px" }}>Lyrics → Rhythm Song Maker（App.js単体版）</h1>
      <p style={{ margin: "0 0 16px", opacity: 0.85, lineHeight: 1.45 }}>
        追加ライブラリなしで動く版です（<b>tone / vexflow / midiライブラリ不要</b>）。
        <br />
        「AIが歌う」っぽさは WebAudio の<b>歌唱風シンセ</b>（ピッチ＋簡易フォルマント＋ビブラート）で表現しています。
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
            <button onClick={generate} style={btnStyle}>生成</button>
            <button onClick={isPlaying ? stopPlayback : play} style={btnStyle}>{isPlaying ? "停止" : "再生"}</button>
            <button onClick={exportMidi} style={btnStyle}>MIDI出力</button>
            <button onClick={exportJson} style={btnStyle}>JSON出力</button>
            <button onClick={copyScore} style={btnStyle}>譜面コピー</button>
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
            <h3 style={{ margin: "10px 0 6px" }}>楽譜（簡易テキスト表示：先頭8小節）</h3>
            <pre style={{ whiteSpace: "pre", overflowX: "auto", padding: 10, borderRadius: 12, border: "1px solid #eee", background: "#fafafa", fontSize: 12, lineHeight: 1.2 }}>
{scoreText}
            </pre>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              ●=音符 / ^ = 歌詞が乗る位置（8分グリッド）。本格譜面は MusicXML/PDF 出力を追加するとできます（今はスタブ）。
            </div>
          </div>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
          <h2 style={{ marginTop: 0 }}>設定</h2>

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
                <option key={ts} value={ts}>{ts}</option>
              ))}
            </select>
          </Row>

          <Row label="Key">
            <select value={keyPreset} onChange={(e) => setKeyPreset(e.target.value)} style={selectStyle}>
              {KEY_PRESETS.map((k) => (
                <option key={k.name} value={k.name}>{k.name}</option>
              ))}
            </select>
          </Row>

          <Row label="Seed">
            <input type="number" value={seed} onChange={(e) => setSeed(parseInt(e.target.value || "1", 10))} style={inputStyle} />
          </Row>

          <details style={{ marginTop: 12 }}>
            <summary style={{ cursor: "pointer" }}>「機能100個」追加用スタブ一覧</summary>
            <ul>
              {FEATURE_STUBS.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
          </details>

          <div style={{ marginTop: 12, padding: 10, borderRadius: 12, border: "1px solid #eee", background: "#fafafa" }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>この版で「修正がApp.jsだけで済む」理由</div>
            <div style={{ fontSize: 13, opacity: 0.9, lineHeight: 1.5 }}>
              外部ライブラリ（tone/vexflow/midi）を一切importしないため、依存追加なしでビルドできます。
              再生は Web Audio API、MIDI書き出しは純JSで実装しています。
            </div>
          </div>
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
