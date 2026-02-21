// App.js
// 依存（任意）: 楽譜表示をきれいにしたい場合は abcjs を入れると便利です。
// npm i abcjs
// ※ abcjs が無い場合でも、ABC記譜（テキスト）として表示はされます。

import React, { useEffect, useMemo, useRef, useState } from "react";

let ABCJS = null; // 動的ロード（入っていれば使う）

/**
 * ざっくり「歌を作る」ためのミニ作曲エンジン（デモ）
 * - 歌詞 -> トークン（音符割り当て単位）に分割
 * - リズム（拍子/テンポ/複雑さ）を生成
 * - メロディ（キー/スケール/複雑さ）を生成
 * - コード進行（簡易）を生成
 * - WebAudioで再生（メロディ＋簡易伴奏）
 * - SpeechSynthesis で歌詞を「歌うように」読み上げ（擬似ボーカル）
 *
 * 本格的な歌声合成（音素タイミング・ピッチ制御）はブラウザ標準だけでは難しいため、
 * ここでは「メロディは音で鳴らす」「歌詞はTTSで同時進行で読み上げる」方式です。
 */

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

const NOTE_NAMES_SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const NOTE_TO_SEMITONE = Object.fromEntries(NOTE_NAMES_SHARP.map((n, i) => [n, i]));

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStringToSeed(str) {
  // シンプルなハッシュ（再現性用）
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function weightedPick(rng, items) {
  // items: [{v, w}]
  const sum = items.reduce((s, it) => s + it.w, 0);
  let x = rng() * sum;
  for (const it of items) {
    x -= it.w;
    if (x <= 0) return it.v;
  }
  return items[items.length - 1].v;
}

function isJapaneseLike(text) {
  // ざっくり: ひらがな/カタカナ/漢字が多いなら日本語扱い
  return /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);
}

function tokenizeLyrics(lyrics) {
  const raw = (lyrics || "").trim();
  if (!raw) return [];

  // 行ごとに扱う（フレーズ）
  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const jp = isJapaneseLike(raw);

  // 1行をトークン列へ
  const tokenizeLine = (line) => {
    // 句読点は軽く区切り
    const cleaned = line.replace(/[、。,.!?！？]/g, " ").trim();
    if (!cleaned) return [];

    if (jp) {
      // 日本語は「スペースがない」ことが多いので、文字ベース（簡易）
      // ただし英数字/記号が混ざる場合はスペース分割を優先
      if (/\s/.test(cleaned)) {
        return cleaned.split(/\s+/).filter(Boolean);
      }
      // 連続する小書きゃゅょっ等は前に結合したいが、ここでは最小限
      const chars = Array.from(cleaned);
      const tokens = [];
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i];
        if (!c.trim()) continue;
        // 小書き文字は前へ結合
        if (/[ゃゅょぁぃぅぇぉャュョァィゥェォっッ]/.test(c) && tokens.length) {
          tokens[tokens.length - 1] += c;
        } else {
          tokens.push(c);
        }
      }
      return tokens;
    }

    // 英語などは単語ベース
    return cleaned.split(/\s+/).filter(Boolean);
  };

  return lines.map((line) => ({
    text: line,
    tokens: tokenizeLine(line),
  }));
}

function buildScaleSemitones(key, mode) {
  // key: "C", "D#", etc. mode: "major" | "minor"
  const root = NOTE_TO_SEMITONE[key] ?? 0;
  const major = [0, 2, 4, 5, 7, 9, 11];
  const minor = [0, 2, 3, 5, 7, 8, 10]; // natural minor
  const pattern = mode === "minor" ? minor : major;
  return pattern.map((x) => (x + root) % 12);
}

function nearestScaleMidi(midi, scaleSemis) {
  // midi の音高を、近いスケール音に丸める（簡易）
  const baseOct = Math.floor(midi / 12);
  const sem = ((midi % 12) + 12) % 12;
  let best = null;
  for (const s of scaleSemis) {
    const cand = baseOct * 12 + s;
    const d = Math.abs(cand - midi);
    if (best == null || d < best.d) best = { midi: cand, d };
    // 上下オクターブも見る
    const candUp = (baseOct + 1) * 12 + s;
    const dUp = Math.abs(candUp - midi);
    if (dUp < best.d) best = { midi: candUp, d: dUp };
    const candDn = (baseOct - 1) * 12 + s;
    const dDn = Math.abs(candDn - midi);
    if (dDn < best.d) best = { midi: candDn, d: dDn };
  }
  return best?.midi ?? midi;
}

function chordFromDegree(key, mode, degree) {
  // degree: 1..7 (スケール上)
  const scaleSemis = buildScaleSemitones(key, mode);
  const rootSemi = scaleSemis[(degree - 1) % 7];
  // triad: degree, degree+2, degree+4
  const thirdSemi = scaleSemis[(degree + 1) % 7];
  const fifthSemi = scaleSemis[(degree + 3) % 7];

  // ルート名だけ返し、品質はざっくり（メジャー/マイナー）推定
  // root->third の間隔が3ならm
  const diff = (thirdSemi - rootSemi + 12) % 12;
  const quality = diff === 3 ? "m" : "";
  const rootName = NOTE_NAMES_SHARP[rootSemi];
  return { name: `${rootName}${quality}`, semis: [rootSemi, thirdSemi, fifthSemi] };
}

function progressionForStyle(style) {
  // シンプルな王道進行テンプレ
  switch (style) {
    case "pop":
      return [1, 5, 6, 4]; // I-V-vi-IV
    case "rock":
      return [1, 4, 5, 4]; // I-IV-V-IV
    case "jazz":
      return [2, 5, 1, 6]; // ii-V-I-vi
    case "ballad":
      return [6, 4, 1, 5]; // vi-IV-I-V
    case "electro":
      return [1, 6, 4, 5]; // I-vi-IV-V
    default:
      return [1, 5, 6, 4];
  }
}

function generateRhythmPattern(rng, timeSig, complexity) {
  // 1小節内の「拍の分割」を返す（単位: 1拍=quarter）
  // timeSig: "4/4" | "3/4"
  const beats = timeSig === "3/4" ? 3 : 4;

  // complexity: 1..10
  const c = clamp(complexity, 1, 10);

  // 候補: 1拍を [1] / [1/2,1/2] / [1/3,1/3,1/3] / [3/4,1/4] / [1/4,3/4] etc.
  const beatSplits = [
    { v: [1], w: 10 - c + 2 },
    { v: [0.5, 0.5], w: 3 + c },
    { v: [0.75, 0.25], w: 2 + c * 0.6 },
    { v: [0.25, 0.75], w: 2 + c * 0.6 },
    { v: [0.25, 0.25, 0.5], w: 1 + c * 0.8 },
    { v: [0.5, 0.25, 0.25], w: 1 + c * 0.8 },
    { v: [0.25, 0.25, 0.25, 0.25], w: Math.max(0.5, c - 3) },
    { v: [1 / 3, 1 / 3, 1 / 3], w: Math.max(0.3, c - 5) },
  ];

  const pattern = [];
  for (let b = 0; b < beats; b++) {
    const split = weightedPick(rng, beatSplits);
    // たまに休符を混ぜる（複雑さに応じて）
    for (const d of split) {
      const restChance = c >= 7 ? 0.08 : c >= 4 ? 0.05 : 0.03;
      pattern.push({ durBeats: d, isRest: rng() < restChance });
    }
  }
  return pattern; // 小節分
}

function generateSong({
  lyrics,
  tempo,
  timeSig,
  key,
  mode,
  style,
  complexity,
  structure, // "verse-chorus" | "through"
  seedText,
}) {
  const seed = hashStringToSeed(seedText || lyrics || "seed");
  const rng = mulberry32(seed);

  const lines = tokenizeLyrics(lyrics);
  if (!lines.length) {
    return { error: "歌詞が空です。歌詞を入力してください。" };
  }

  const beatsPerBar = timeSig === "3/4" ? 3 : 4;

  // だいたいの「1トークン=1音符」だけど、長い行は小節を増やす
  // 小節数はトークン数から推定
  const barsPerLineBase = 2; // 最低2小節くらい
  const maxTokensPerBar = timeSig === "3/4" ? 6 : 8; // 8分音符想定

  const scaleSemis = buildScaleSemitones(key, mode);

  // ボーカル域（MIDI）
  const vocalLow = 57; // A3
  const vocalHigh = 76; // E5
  let currentMidi = nearestScaleMidi(64, scaleSemis); // E4付近開始

  // スタイル別に「動き方」を調整
  const stepWeight = style === "ballad" ? 9 : style === "jazz" ? 6 : 8;
  const leapWeight = style === "jazz" ? 4 : style === "rock" ? 3 : 2;
  const zigzagBias = style === "electro" ? 0.55 : 0.5;

  // コード進行
  const progDegrees = progressionForStyle(style);
  const chordBars = 4; // 4小節単位でループ
  const chordSeq = [];
  for (let i = 0; i < 64; i++) {
    chordSeq.push(chordFromDegree(key, mode, progDegrees[i % progDegrees.length]));
  }

  // 構成（簡易）: verse/chorus を生成して繰り返し
  // verse: 入力の先頭半分、chorus: 全体からサビっぽく短く再構成
  const allLineTexts = lines.map((l) => l.text);
  const verseLines = lines.slice(0, Math.max(1, Math.ceil(lines.length * 0.6)));
  const chorusSource = lines.slice(Math.max(0, lines.length - Math.max(1, Math.ceil(lines.length * 0.4))));
  const chorusLines = chorusSource.length ? chorusSource : lines;

  const sections =
    structure === "verse-chorus"
      ? [
          { name: "Verse", lines: verseLines },
          { name: "Chorus", lines: chorusLines },
          { name: "Verse", lines: verseLines },
          { name: "Chorus", lines: chorusLines },
        ]
      : [{ name: "Song", lines }];

  // メロディイベント（時間は拍基準で後で秒へ）
  // event: { tBeats, durBeats, midi, lyricToken, barIndex, isRest }
  const melody = [];
  const lyricTimeline = []; // 読み上げ用のフレーズタイミング

  let tBeats = 0;
  let barIndex = 0;

  // 「複雑」ほど: リズム細かい/跳躍多め/装飾音（短いノート）追加
  const c = clamp(complexity, 1, 10);
  const ornamentChance = c >= 8 ? 0.18 : c >= 6 ? 0.12 : c >= 4 ? 0.08 : 0.04;

  for (const sec of sections) {
    // セクション開始でフレーズ追加（TTS）
    lyricTimeline.push({ tBeats, text: `♪ ${sec.name}` });

    for (const line of sec.lines) {
      const tokens = line.tokens.length ? line.tokens : [line.text];
      // 何小節使うか
      const estBars = Math.max(barsPerLineBase, Math.ceil(tokens.length / maxTokensPerBar));
      const bars = clamp(estBars, 2, 8);

      // TTS: 行ごとにタイミング登録
      lyricTimeline.push({ tBeats, text: line.text });

      let tokenIdx = 0;
      for (let b = 0; b < bars; b++) {
        const pat = generateRhythmPattern(rng, timeSig, c);
        for (const step of pat) {
          const tok = tokenIdx < tokens.length ? tokens[tokenIdx] : ""; // 余ったら空
          tokenIdx++;

          // 休符ならノート無し
          if (step.isRest || !tok) {
            melody.push({
              tBeats,
              durBeats: step.durBeats,
              midi: null,
              lyricToken: tok,
              barIndex,
              isRest: true,
            });
            tBeats += step.durBeats;
            continue;
          }

          // 次の音高を決める（ステップ/跳躍/ジグザグ）
          const dir = rng() < zigzagBias ? (rng() < 0.5 ? -1 : 1) : 1;
          const move = weightedPick(rng, [
            { v: 0, w: 2 },
            { v: 1 * dir, w: stepWeight },
            { v: 2 * dir, w: stepWeight * 0.7 },
            { v: 3 * dir, w: leapWeight },
            { v: 4 * dir, w: leapWeight * 0.8 },
            { v: 5 * dir, w: leapWeight * 0.5 },
            { v: 7 * dir, w: Math.max(0.5, c - 7) }, // 5度跳躍（高複雑向け）
          ]);

          // スケール音に沿うように「音度移動」っぽく処理
          // 現在midiを半音ではなく、近いスケール音へ寄せる
          let nextMidi = currentMidi + move * 2; // ざっくり（2半音=全音）で動かす
          nextMidi = nearestScaleMidi(nextMidi, scaleSemis);

          // 範囲に収める
          if (nextMidi < vocalLow) nextMidi += 12;
          if (nextMidi > vocalHigh) nextMidi -= 12;

          currentMidi = nextMidi;

          // 装飾音（とても短い前打音）を入れることがある
          if (rng() < ornamentChance && step.durBeats >= 0.5) {
            const graceDur = Math.max(0.125, step.durBeats * 0.25);
            const mainDur = step.durBeats - graceDur;

            const graceMidi = nearestScaleMidi(currentMidi + (rng() < 0.5 ? -2 : 2), scaleSemis);

            melody.push({
              tBeats,
              durBeats: graceDur,
              midi: graceMidi,
              lyricToken: "",
              barIndex,
              isRest: false,
              isOrnament: true,
            });
            tBeats += graceDur;

            melody.push({
              tBeats,
              durBeats: mainDur,
              midi: currentMidi,
              lyricToken: tok,
              barIndex,
              isRest: false,
            });
            tBeats += mainDur;
          } else {
            melody.push({
              tBeats,
              durBeats: step.durBeats,
              midi: currentMidi,
              lyricToken: tok,
              barIndex,
              isRest: false,
            });
            tBeats += step.durBeats;
          }
        }
        barIndex++;
      }
    }
  }

  const totalBeats = tBeats;
  const barsTotal = Math.ceil(totalBeats / beatsPerBar);

  // 伴奏（簡易）: ルート+5度のパワーコード、またはジャズ風に3度も少し
  const chords = [];
  for (let b = 0; b < barsTotal; b++) {
    const chord = chordSeq[b % chordBars];
    chords.push({ bar: b, chord });
  }

  // ABC記譜（テキスト）を組み立て
  const abc = buildABC({
    melody,
    chords,
    tempo,
    timeSig,
    key,
    mode,
    title: "Auto Song",
    beatsPerBar,
  });

  return {
    seed,
    sections: sections.map((s) => s.name),
    melody,
    chords,
    lyricTimeline,
    beatsPerBar,
    totalBeats,
    tempo,
    timeSig,
    key,
    mode,
    style,
    complexity: c,
    abc,
    originalLines: allLineTexts,
  };
}

function buildABC({ melody, chords, tempo, timeSig, key, mode, title, beatsPerBar }) {
  // ABCJSで表示できる程度の簡易ABC
  // L: 1/8 を基本、durBeats(quarter) を 8分音符単位へ変換
  // 1拍(quarter)=2*(1/8) なので dur8 = durBeats * 2
  const meter = timeSig;
  const K = `${key}${mode === "minor" ? "m" : ""}`;

  // MIDI->ABC音名（簡易、#中心、オクターブ）
  function midiToABC(m) {
    // C4=60 -> C
    const sem = ((m % 12) + 12) % 12;
    const octave = Math.floor(m / 12) - 1; // MIDI octave
    const name = NOTE_NAMES_SHARP[sem]; // C#
    let abcName = "";
    if (name.includes("#")) {
      abcName = "^" + name[0]; // ^C
    } else {
      abcName = name;
    }

    // ABC: C (octave 4) を基準に、小文字で上、カンマで下
    // ABCの厳密なオクターブ規則は複雑なので、ここでは実用優先の簡易
    // 目安: octave 4 -> 大文字, octave 5 -> 小文字
    if (octave >= 5) {
      abcName = abcName.toLowerCase();
      const ups = octave - 5;
      abcName += "'".repeat(ups);
    } else if (octave <= 4) {
      // octave 4: 大文字（そのまま）
      const downs = 4 - octave;
      abcName += ",".repeat(downs);
    }
    return abcName;
  }

  function durToABC(durBeats) {
    const dur8 = Math.round(durBeats * 2 * 8) / 8; // 1/8単位に丸め（微妙な誤差吸収）
    // L:1/8 なので 1 = 1/8, 2 = 1/4, 4=1/2, 8=1
    // dur8 は「8分音符何個分」相当
    const units = Math.max(0.125, dur8);
    if (Math.abs(units - 1) < 1e-6) return ""; // 1/8は省略
    if (Number.isInteger(units)) return String(units);
    // 分数表記
    // 例: 0.5 -> /2, 1.5 -> 3/2
    const denom = 8;
    const num = Math.round(units * denom);
    // できるだけ簡略化
    const g = gcd(num, denom);
    const n = num / g;
    const d = denom / g;
    if (n === 1) return `/${d}`;
    return `${n}/${d}`;
  }

  function gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a || 1;
  }

  // コード（小節頭に表示）
  const chordByBar = new Map();
  for (const c of chords) chordByBar.set(c.bar, c.chord.name);

  // 小節区切りしながら書く
  const beatsPerBarLocal = beatsPerBar;
  let out = "";
  let beatInBar = 0;
  let barIndex = 0;

  for (const ev of melody) {
    // 小節先頭ならコードを付ける
    if (Math.abs(beatInBar) < 1e-9) {
      const ch = chordByBar.get(barIndex);
      if (ch) out += `"${ch}"`;
    }

    if (ev.isRest || ev.midi == null) {
      out += "z" + durToABC(ev.durBeats) + " ";
    } else {
      out += midiToABC(ev.midi) + durToABC(ev.durBeats) + " ";
    }

    beatInBar += ev.durBeats;
    // 小節をまたぐ可能性もあるので while で処理
    while (beatInBar >= beatsPerBarLocal - 1e-9) {
      out += "| ";
      beatInBar -= beatsPerBarLocal;
      barIndex++;
    }
  }

  const header = [
    "X:1",
    `T:${title}`,
    `M:${meter}`,
    "L:1/8",
    `Q:1/4=${tempo}`,
    `K:${K}`,
  ].join("\n");

  return `${header}\n${out.trim()}\n`;
}

function safeCancelSpeech() {
  try {
    window.speechSynthesis?.cancel?.();
  } catch {
    // ignore
  }
}

function App() {
  const [lyrics, setLyrics] = useState(
    "風吹けば　心は\n揺れても　進むよ\n夜明けの　リズムで\n君へと　歌うよ"
  );

  const [tempo, setTempo] = useState(120);
  const [timeSig, setTimeSig] = useState("4/4");
  const [key, setKey] = useState("C");
  const [mode, setMode] = useState("major");
  const [style, setStyle] = useState("pop");
  const [complexity, setComplexity] = useState(6);
  const [structure, setStructure] = useState("verse-chorus");

  const [seedText, setSeedText] = useState("");
  const [autoSeed, setAutoSeed] = useState(true);

  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [voiceRate, setVoiceRate] = useState(1.0);
  const [voicePitch, setVoicePitch] = useState(1.1);
  const [voiceVolume, setVoiceVolume] = useState(1.0);

  const [generated, setGenerated] = useState(null);
  const [error, setError] = useState("");

  const [isPlaying, setIsPlaying] = useState(false);

  const audioRef = useRef({
    ctx: null,
    master: null,
    nodes: [],
    startTime: 0,
    stopFlag: false,
  });

  const abcRef = useRef(null);

  const song = useMemo(() => {
    const res = generateSong({
      lyrics,
      tempo: Number(tempo),
      timeSig,
      key,
      mode,
      style,
      complexity: Number(complexity),
      structure,
      seedText: autoSeed ? "" : seedText,
    });
    return res;
  }, [lyrics, tempo, timeSig, key, mode, style, complexity, structure, seedText, autoSeed]);

  useEffect(() => {
    if (song?.error) {
      setError(song.error);
      setGenerated(null);
      return;
    }
    setError("");
    setGenerated(song);
  }, [song]);

  useEffect(() => {
    // abcjsが入っていれば使う
    // eslint-disable-next-line global-require
    (async () => {
      try {
        // abcjs は CommonJS/ESM差があるので安全にimport
        const mod = await import("abcjs");
        ABCJS = mod?.default ?? mod;
      } catch {
        ABCJS = null;
      }
    })();
  }, []);

  useEffect(() => {
    // 楽譜レンダリング
    if (!generated?.abc) return;
    if (!abcRef.current) return;

    if (ABCJS?.renderAbc) {
      try {
        ABCJS.renderAbc(abcRef.current, generated.abc, {
          responsive: "resize",
        });
      } catch {
        // fallback: 何もしない
      }
    }
  }, [generated]);

  useEffect(() => {
    // アンマウント時に停止
    return () => {
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function ensureAudio() {
    const st = audioRef.current;
    if (st.ctx && st.master) return;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = 0.7;
    master.connect(ctx.destination);

    st.ctx = ctx;
    st.master = master;
    st.nodes = [];
  }

  function scheduleTone({ t, dur, freq, type = "sine", gain = 0.12 }) {
    const st = audioRef.current;
    const ctx = st.ctx;
    const master = st.master;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);

    // 簡易エンベロープ
    const a = Math.min(0.02, dur * 0.2);
    const r = Math.min(0.06, dur * 0.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, Math.max(t + a + 0.001, t + dur - r));

    osc.connect(g);
    g.connect(master);

    osc.start(t);
    osc.stop(t + dur + 0.05);

    st.nodes.push(osc, g);
  }

  function scheduleChord({ t, dur, rootMidi, styleLocal }) {
    // 伴奏: ルート＋5度（+オクターブ）中心、jazzは3度を薄く追加
    const st = audioRef.current;
    if (!st.ctx) return;

    const ctx = st.ctx;

    const rootFreq = midiToFreq(rootMidi);
    scheduleTone({ t, dur, freq: rootFreq, type: styleLocal === "electro" ? "sawtooth" : "triangle", gain: 0.09 });
    scheduleTone({ t, dur, freq: rootFreq * Math.pow(2, 7 / 12), type: "triangle", gain: 0.06 });
    scheduleTone({ t, dur, freq: rootFreq / 2, type: "sine", gain: 0.06 });

    if (styleLocal === "jazz") {
      scheduleTone({ t, dur, freq: rootFreq * Math.pow(2, 3 / 12), type: "sine", gain: 0.03 });
      scheduleTone({ t, dur, freq: rootFreq * Math.pow(2, 10 / 12), type: "sine", gain: 0.02 });
    }

    // 軽いハイハット風ノイズ（複雑さ高いとだけ）
    if (complexity >= 7) {
      const noiseDur = Math.min(0.04, dur * 0.12);
      for (let i = 0; i < 2; i++) {
        const tt = t + i * (dur / 2);
        const bufferSize = Math.floor(ctx.sampleRate * noiseDur);
        const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let j = 0; j < bufferSize; j++) data[j] = (Math.random() * 2 - 1) * Math.exp(-j / (bufferSize / 3));
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const g = ctx.createGain();
        g.gain.value = 0.02;
        src.connect(g);
        g.connect(audioRef.current.master);
        src.start(tt);
        src.stop(tt + noiseDur);
        audioRef.current.nodes.push(src, g);
      }
    }
  }

  function speakTimeline(timeline, beatToSec, startAtSec) {
    if (!voiceEnabled) return;
    if (!window.speechSynthesis) return;

    safeCancelSpeech();

    // ブラウザのTTSは「未来の時刻に正確に開始」が難しいので、
    // setTimeout でざっくり同期
    for (const item of timeline) {
      const delayMs = Math.max(0, (startAtSec + beatToSec(item.tBeats) - performance.now() / 1000) * 1000);
      window.setTimeout(() => {
        // 停止されたら発話しない
        if (audioRef.current.stopFlag) return;
        const u = new SpeechSynthesisUtterance(item.text);
        u.rate = clamp(voiceRate, 0.6, 1.4);
        u.pitch = clamp(voicePitch, 0.5, 2.0);
        u.volume = clamp(voiceVolume, 0.0, 1.0);
        window.speechSynthesis.speak(u);
      }, delayMs);
    }
  }

  async function play() {
    if (!generated || generated.error) return;

    try {
      ensureAudio();
      const st = audioRef.current;
      st.stopFlag = false;

      // iOS/Chrome対策: user gesture 直後にresume
      await st.ctx.resume();

      // 既に再生中なら一旦停止
      stop(true);

      const bpm = generated.tempo;
      const secPerBeat = 60 / bpm;

      const now = st.ctx.currentTime;
      // 少し先から開始
      const startTime = now + 0.12;
      st.startTime = startTime;

      // コード（小節ごと）
      const beatsPerBar = generated.beatsPerBar;
      for (const c of generated.chords) {
        const tBeats = c.bar * beatsPerBar;
        const t = startTime + tBeats * secPerBeat;

        // chord.semis[0] がルート半音。適当なオクターブへ（ベース域）
        const rootSemi = c.chord.semis[0];
        const rootMidi = 36 + rootSemi; // C2付近
        scheduleChord({ t, dur: beatsPerBar * secPerBeat, rootMidi, styleLocal: generated.style });
      }

      // メロディ
      for (const ev of generated.melody) {
        if (ev.isRest || ev.midi == null) continue;
        const t = startTime + ev.tBeats * secPerBeat;
        const dur = ev.durBeats * secPerBeat;

        // 装飾音は軽く、通常音は少し強め
        const gain = ev.isOrnament ? 0.06 : 0.12;
        const type =
          generated.style === "electro" ? "sawtooth" : generated.style === "rock" ? "square" : "sine";

        scheduleTone({ t, dur, freq: midiToFreq(ev.midi), type, gain });
      }

      // 擬似ボーカル（TTS）
      const beatToSec = (b) => b * secPerBeat;
      // performance.now() を基準に setTimeout するため、開始時刻を推定
      const startAtSecWall = performance.now() / 1000 + (startTime - st.ctx.currentTime);
      speakTimeline(generated.lyricTimeline, beatToSec, startAtSecWall);

      setIsPlaying(true);

      // 終了判定
      const endSec = startTime + generated.totalBeats * secPerBeat + 0.2;
      window.setTimeout(() => {
        if (!audioRef.current.stopFlag) {
          setIsPlaying(false);
        }
      }, Math.max(0, (endSec - st.ctx.currentTime) * 1000));
    } catch (e) {
      setError(`再生に失敗しました: ${String(e?.message || e)}`);
      setIsPlaying(false);
    }
  }

  function stop(soft = false) {
    const st = audioRef.current;
    st.stopFlag = true;

    safeCancelSpeech();

    if (st.nodes?.length) {
      for (const n of st.nodes) {
        try {
          if (n.stop) n.stop();
        } catch {
          // ignore
        }
        try {
          if (n.disconnect) n.disconnect();
        } catch {
          // ignore
        }
      }
      st.nodes = [];
    }

    if (!soft) {
      // ctxを閉じると次回に作り直し必要。ここでは残す（体感を軽く）
      // 必要なら ctx.close() に切り替え可
    }
    setIsPlaying(false);
  }

  function randomizeSeed() {
    setAutoSeed(false);
    setSeedText(String(Math.floor(Math.random() * 1e9)));
  }

  function copyABC() {
    if (!generated?.abc) return;
    navigator.clipboard?.writeText?.(generated.abc);
  }

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: 16, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif" }}>
      <h1 style={{ margin: "8px 0 4px" }}>歌詞から自動作曲（リズム重視）デモ</h1>
      <div style={{ color: "#555", marginBottom: 12, lineHeight: 1.5 }}>
        歌詞を入力 → リズム／メロディ／コードを自動生成して再生します。<br />
        「歌うように」はブラウザ標準の音声合成（TTS）で擬似的に歌詞を読み上げます（本格的な歌声合成ではありません）。
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 0.8fr", gap: 12, alignItems: "start" }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <h2 style={{ margin: 0, fontSize: 18 }}>歌詞</h2>
            <div style={{ fontSize: 12, color: "#666" }}>
              行ごとにフレーズ扱い（Verse/Chorus構成は設定で変更）
            </div>
          </div>
          <textarea
            value={lyrics}
            onChange={(e) => setLyrics(e.target.value)}
            rows={10}
            style={{
              width: "100%",
              marginTop: 8,
              padding: 10,
              borderRadius: 10,
              border: "1px solid #ccc",
              outline: "none",
              lineHeight: 1.5,
              fontSize: 14,
              resize: "vertical",
            }}
            placeholder={"歌詞を入力してください（改行でフレーズ）"}
          />

          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <button
              onClick={() => (isPlaying ? stop() : play())}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #222",
                background: isPlaying ? "#222" : "#fff",
                color: isPlaying ? "#fff" : "#222",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              {isPlaying ? "停止" : "再生"}
            </button>

            <button
              onClick={() => {
                stop();
                // 生成は useMemo で自動更新されるので「止める」だけでOK
              }}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #ccc",
                background: "#fff",
                cursor: "pointer",
                fontWeight: 600,
              }}
            >
              再生成（停止）
            </button>

            <button
              onClick={copyABC}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #ccc",
                background: "#fff",
                cursor: "pointer",
                fontWeight: 600,
              }}
              title="ABC記譜をクリップボードへ"
            >
              ABCをコピー
            </button>
          </div>

          {error ? (
            <div style={{ marginTop: 10, padding: 10, borderRadius: 10, background: "#fff3f3", border: "1px solid #f2b8b8", color: "#8a1f1f" }}>
              {error}
            </div>
          ) : null}
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>設定</h2>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }}>
            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              テンポ（BPM）
              <input
                type="number"
                value={tempo}
                onChange={(e) => setTempo(clamp(Number(e.target.value || 0), 40, 220))}
                min={40}
                max={220}
                style={{ padding: 8, borderRadius: 10, border: "1px solid #ccc" }}
              />
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              拍子
              <select value={timeSig} onChange={(e) => setTimeSig(e.target.value)} style={{ padding: 8, borderRadius: 10, border: "1px solid #ccc" }}>
                <option value="4/4">4/4</option>
                <option value="3/4">3/4</option>
              </select>
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              キー
              <select value={key} onChange={(e) => setKey(e.target.value)} style={{ padding: 8, borderRadius: 10, border: "1px solid #ccc" }}>
                {NOTE_NAMES_SHARP.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              モード
              <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ padding: 8, borderRadius: 10, border: "1px solid #ccc" }}>
                <option value="major">major</option>
                <option value="minor">minor</option>
              </select>
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              スタイル
              <select value={style} onChange={(e) => setStyle(e.target.value)} style={{ padding: 8, borderRadius: 10, border: "1px solid #ccc" }}>
                <option value="pop">pop</option>
                <option value="rock">rock</option>
                <option value="ballad">ballad</option>
                <option value="jazz">jazz</option>
                <option value="electro">electro</option>
              </select>
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              複雑さ（1〜10）
              <input
                type="range"
                value={complexity}
                onChange={(e) => setComplexity(clamp(Number(e.target.value), 1, 10))}
                min={1}
                max={10}
              />
              <div style={{ display: "flex", justifyContent: "space-between", color: "#666", fontSize: 12 }}>
                <span>シンプル</span>
                <span>{complexity}</span>
                <span>複雑</span>
              </div>
            </label>

            <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
              構成
              <select value={structure} onChange={(e) => setStructure(e.target.value)} style={{ padding: 8, borderRadius: 10, border: "1px solid #ccc" }}>
                <option value="verse-chorus">Verse / Chorus</option>
                <option value="through">通し（全行を1回）</option>
              </select>
            </label>
          </div>

          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #eee" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h3 style={{ margin: 0, fontSize: 15 }}>歌うように（TTS）</h3>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={voiceEnabled} onChange={(e) => setVoiceEnabled(e.target.checked)} />
                有効
              </label>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10, marginTop: 10 }}>
              <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
                速さ
                <input
                  type="range"
                  min={0.6}
                  max={1.4}
                  step={0.05}
                  value={voiceRate}
                  onChange={(e) => setVoiceRate(Number(e.target.value))}
                />
                <div style={{ fontSize: 12, color: "#666" }}>{voiceRate.toFixed(2)}</div>
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
                ピッチ
                <input
                  type="range"
                  min={0.5}
                  max={2.0}
                  step={0.05}
                  value={voicePitch}
                  onChange={(e) => setVoicePitch(Number(e.target.value))}
                />
                <div style={{ fontSize: 12, color: "#666" }}>{voicePitch.toFixed(2)}</div>
              </label>
              <label style={{ display: "grid", gap: 6, fontSize: 13 }}>
                音量
                <input
                  type="range"
                  min={0.0}
                  max={1.0}
                  step={0.05}
                  value={voiceVolume}
                  onChange={(e) => setVoiceVolume(Number(e.target.value))}
                />
                <div style={{ fontSize: 12, color: "#666" }}>{voiceVolume.toFixed(2)}</div>
              </label>
            </div>
          </div>

          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #eee" }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>シード（同じ歌詞でも別メロ）</h3>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={autoSeed} onChange={(e) => setAutoSeed(e.target.checked)} />
                自動（歌詞から決定）
              </label>
              <input
                disabled={autoSeed}
                value={seedText}
                onChange={(e) => setSeedText(e.target.value)}
                placeholder="seed"
                style={{ padding: 8, borderRadius: 10, border: "1px solid #ccc", minWidth: 160 }}
              />
              <button
                onClick={randomizeSeed}
                style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc", background: "#fff", cursor: "pointer", fontWeight: 600 }}
              >
                ランダム
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: "#666", lineHeight: 1.4 }}>
              自動ON: 歌詞が同じなら毎回同じ曲になります。自動OFF + seedを変えると別バリエーションになります。
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>楽譜（ABC / 任意でレンダリング）</h2>

        {ABCJS?.renderAbc ? (
          <div style={{ marginTop: 10 }}>
            <div ref={abcRef} />
            <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>
              abcjs が使える場合は上に譜面表示します（環境によっては表示されない場合があります）。
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10, fontSize: 12, color: "#666" }}>
            abcjs が未導入のため、下のABC記譜テキストを譜面化ツールに貼り付けると表示できます。
          </div>
        )}

        <pre
          style={{
            marginTop: 10,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #eee",
            background: "#fafafa",
            overflowX: "auto",
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          {generated?.abc || "（未生成）"}
        </pre>
      </div>

      <div style={{ marginTop: 12, border: "1px solid #ddd", borderRadius: 12, padding: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>生成内容（概要）</h2>
        {generated ? (
          <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>曲のパラメータ</div>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                <div>Tempo: {generated.tempo} BPM</div>
                <div>Time: {generated.timeSig}</div>
                <div>Key: {generated.key} {generated.mode}</div>
                <div>Style: {generated.style}</div>
                <div>Complexity: {generated.complexity}</div>
                <div>Seed: {generated.seed}</div>
                <div>Sections: {generated.sections.join(" → ")}</div>
              </div>
            </div>

            <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 8 }}>TTSタイムライン</div>
              <div style={{ fontSize: 13, lineHeight: 1.6 }}>
                {generated.lyricTimeline.slice(0, 10).map((x, i) => (
                  <div key={i}>
                    beat {x.tBeats.toFixed(2)}: {x.text}
                  </div>
                ))}
                {generated.lyricTimeline.length > 10 ? (
                  <div style={{ color: "#666", marginTop: 6 }}>…他 {generated.lyricTimeline.length - 10} 件</div>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 10, color: "#666" }}>歌詞を入力すると生成されます。</div>
        )}
      </div>

      <div style={{ marginTop: 12, color: "#666", fontSize: 12, lineHeight: 1.5 }}>
        <b>注意:</b> ブラウザの自動再生制限のため、再生ボタンを押すまでは音が鳴りません。TTSの声質や言語はOS/ブラウザ依存です。<br />
        さらに高度な「本当の歌声合成（音素整列・ピッチ同期）」をしたい場合は、別途ボーカル合成エンジン（例: サーバー側生成、歌声合成モデル等）と連携する設計が必要です。
      </div>
    </div>
  );
}

export default App;
