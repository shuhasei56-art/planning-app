
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Super Planner (Google Calendar-like UI) — single-file App.js
 * - Firebase Auth (Google), Firestore sync
 * - Calendar Month/Week/Day views (lightweight custom grid)
 * - Tasks, Events, Time blocks, Habits, Notes
 * - AI-like assistant chat (local heuristic) + "今日なにする？" daily plan
 *
 * ✅ How to use (CRA / Vite):
 * 1) npm i firebase
 * 2) Paste this file as src/App.js
 * 3) Ensure your Firebase project has:
 *    - Authentication: Google enabled
 *    - Firestore: enabled (test rules during dev)
 * 4) Run: npm start
 *
 * NOTE: This is a client-only demo. For real AI (OpenAI etc.), call your own server endpoint.
 */

// -------------------- Firebase --------------------
import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  deleteDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
} from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyDE5unWW2OVIbMPSVmRi4m6Zvog-MaCqCo",
  authDomain: "task-build-7e2fc.firebaseapp.com",
  projectId: "task-build-7e2fc",
  storageBucket: "task-build-7e2fc.firebasestorage.app",
  messagingSenderId: "57392741303",
  appId: "1:57392741303:web:4afd91bb943fc76cf48632",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// -------------------- Utils --------------------
const pad2 = (n) => String(n).padStart(2, "0");

function toISODate(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseISODate(iso) {
  const [y, m, da] = iso.split("-").map((x) => parseInt(x, 10));
  return new Date(y, m - 1, da);
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}
function startOfWeek(d, weekStartsOnMonday = true) {
  const x = new Date(d);
  const day = x.getDay(); // 0=Sun
  const offset = weekStartsOnMonday ? (day === 0 ? -6 : 1 - day) : -day;
  x.setDate(x.getDate() + offset);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function humanTime(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${pad2(h)}:${pad2(m)}`;
}

const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"];

const DEFAULT_SETTINGS = {
  weekStartsOnMonday: true,
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Tokyo",
  workingHours: { start: 9, end: 18 },
  focusMode: false,
  showWeekNumbers: false,
  showHolidays: true,
  smartSuggestions: true,
  autoTimeBlocking: true,
  autoBreaks: true,
  pomodoro: { enabled: false, workMin: 25, breakMin: 5, longBreakMin: 15, cycles: 4 },
  notifications: { enabled: true, push: false, email: false },
  theme: "light",
  density: "comfortable",
  language: "ja",
  defaultEventDurationMin: 60,
  defaultTaskEstimateMin: 30,
};

// -------------------- Feature catalog (≈100) --------------------
const FEATURE_CATALOG = [
  // Calendar Core (1-20)
  "月表示", "週表示", "日表示", "アジェンダ表示", "ドラッグで日付移動(簡易)",
  "イベント作成/編集/削除", "タスク作成/編集/削除", "色分け(タグ/カレンダー)",
  "祝日表示(簡易)", "週の開始曜日切替", "検索", "フィルタ(タグ/優先度/状態)",
  "印刷(簡易)", "エクスポート(iCal風JSON)", "インポート(JSON)",
  "ショートカット(簡易)", "複製", "テンプレート", "リマインド(ローカル通知の準備)", "オフラインキャッシュ",
  // Planning & Productivity (21-45)
  "タイムブロッキング", "作業時間見積", "締切管理", "優先度", "ステータス(未/進/完)",
  "チェックリスト(サブタスク)", "クイック追加", "今日/明日/今週スマートリスト",
  "習慣トラッカー", "目標(OKR)メモ", "ノート(ミーティング議事録)", "リンク添付",
  "集中モード", "ポモドーロ", "休憩自動提案", "エネルギーレベル(朝/昼/夜)",
  "作業場所(自宅/職場など)", "繰り返し(簡易ルール)", "バッファ時間", "やることの重さ(難易度)",
  "タスクの分割提案", "見積 vs 実績", "週間レビュー", "日次振り返り", "週次目標",
  // Collaboration (46-60)
  "共有(将来拡張の枠)", "コメント欄", "メンション(将来)", "役割(将来)", "公開リンク(将来)",
  "参加者(将来)", "共同編集(将来)", "閲覧専用モード(将来)", "通知設定", "アクセス制御(Firestoreルール)",
  "カレンダー複数(将来)", "外部カレンダー連携(将来)", "Slack/メール連携(将来)", "会議調整(将来)", "空き時間検索(将来)",
  // AI Assistant (61-80)
  "AIチャット", "今日のおすすめ行動", "優先順位付け提案", "時間割提案", "タスク分解",
  "スケジュール衝突検出", "作業のまとめ(バッチ化)", "集中枠の提案", "休憩提案", "先延ばし検知(簡易)",
  "やる気が低い日プラン", "短時間で終わる順", "締切が近い順", "重要度×緊急度マトリクス", "予定の要約",
  "会議前の準備リスト", "日次ブリーフィング", "週間プレビュー", "自然言語入力(簡易パーサ)", "AIプロンプトの履歴",
  // Analytics & Insights (81-92)
  "完了率", "作業時間集計(簡易)", "タグ別集計(簡易)", "集中時間", "休憩時間",
  "曜日別傾向(簡易)", "月次レポート(簡易)", "未完了タスクの滞留日数", "推定時間の精度", "カレンダー混雑度",
  "負荷スコア", "目標達成進捗(簡易)",
  // Quality-of-life (93-110)
  "ダーク/ライト", "密度(コンパクト)", "キーボードで移動", "Undo(簡易)", "スヌーズ(簡易)",
  "スター(重要)", "ピン留め", "アーカイブ", "ゴミ箱(簡易)", "履歴(簡易)",
  "複数選択(簡易)", "ドラッグ選択(将来)", "マルチデバイス同期(Firebase)", "ログイン/ログアウト", "初期オンボーディング",
  "設定画面", "データバックアップ(JSON)", "データ復元(JSON)", "エラーログ(簡易)", "ヘルプ/チュートリアル(簡易)",
];

// -------------------- AI heuristics --------------------
function scoreTask(task) {
  // Higher score => do sooner
  // Factors: due date proximity, priority, estimate size, created age, status
  const pri = { low: 1, normal: 2, high: 3, critical: 4 }[task.priority || "normal"] || 2;
  const statusPenalty = task.status === "done" ? -999 : task.status === "doing" ? 2 : 0;

  let dueScore = 0;
  if (task.dueDate) {
    const due = parseISODate(task.dueDate);
    const diffDays = Math.round((due - new Date()) / (24 * 3600 * 1000));
    dueScore = clamp(10 - diffDays, -10, 20); // overdue => bigger
  }
  const estimate = task.estimateMin || 30;
  const quickWin = estimate <= 15 ? 3 : estimate <= 30 ? 1 : estimate >= 120 ? -2 : 0;
  const star = task.starred ? 2 : 0;
  const difficulty = { easy: 1, medium: 0, hard: -1 }[task.difficulty || "medium"] || 0;

  return pri * 5 + dueScore + quickWin + star + difficulty + statusPenalty;
}

function buildTodaysPlan({ dateISO, tasks, events, settings }) {
  const date = parseISODate(dateISO);
  const dayStart = new Date(date); dayStart.setHours(settings.workingHours.start, 0, 0, 0);
  const dayEnd = new Date(date); dayEnd.setHours(settings.workingHours.end, 0, 0, 0);

  // Busy blocks from events
  const busy = events
    .filter((e) => e.dateISO === dateISO)
    .map((e) => ({
      startMin: e.startMin ?? 9 * 60,
      endMin: e.endMin ?? (e.startMin ?? 9 * 60) + (e.durationMin ?? settings.defaultEventDurationMin),
      title: e.title,
      type: "event",
      id: e.id,
    }))
    .sort((a, b) => a.startMin - b.startMin);

  // Free slots
  const free = [];
  let cursor = settings.workingHours.start * 60;
  const end = settings.workingHours.end * 60;
  for (const b of busy) {
    const bs = clamp(b.startMin, cursor, end);
    const be = clamp(b.endMin, cursor, end);
    if (bs > cursor) free.push({ startMin: cursor, endMin: bs });
    cursor = Math.max(cursor, be);
  }
  if (cursor < end) free.push({ startMin: cursor, endMin: end });

  // Pick tasks for today (not done)
  const candidates = tasks
    .filter((t) => t.status !== "done")
    .filter((t) => !t.scheduledDateISO || t.scheduledDateISO === dateISO)
    .slice()
    .sort((a, b) => scoreTask(b) - scoreTask(a));

  // Greedy schedule into free slots
  const scheduled = [];
  let remaining = candidates.map((t) => ({ ...t, remainingMin: t.estimateMin || settings.defaultTaskEstimateMin }));

  for (const slot of free) {
    let s = slot.startMin;
    const slotEnd = slot.endMin;
    while (s < slotEnd && remaining.length) {
      const task = remaining[0];

      // auto breaks
      const workChunk = Math.min(task.remainingMin, slotEnd - s);
      if (workChunk <= 0) break;

      scheduled.push({
        type: "task",
        title: task.title,
        startMin: s,
        endMin: s + workChunk,
        taskId: task.id,
        priority: task.priority || "normal",
      });

      task.remainingMin -= workChunk;
      s += workChunk;

      // insert break suggestion
      if (settings.autoBreaks && workChunk >= 45 && s + 10 <= slotEnd) {
        scheduled.push({
          type: "break",
          title: "休憩",
          startMin: s,
          endMin: s + 10,
        });
        s += 10;
      }

      if (task.remainingMin <= 0) {
        remaining.shift();
      } else {
        // keep same task at front to continue next free time
      }
    }
  }

  // Add "top 3" list
  const top3 = candidates.slice(0, 3);

  const summary = {
    dateISO,
    top3,
    freeSlots: free,
    busyBlocks: busy,
    timeTable: scheduled,
  };
  return summary;
}

function formatPlanToText(plan) {
  const lines = [];
  lines.push(`【${plan.dateISO} のおすすめ】`);
  if (plan.top3.length) {
    lines.push("まずはこれ（上位3つ）:");
    plan.top3.forEach((t, idx) => {
      lines.push(`${idx + 1}. ${t.title}${t.dueDate ? `（期限: ${t.dueDate}）` : ""}${t.estimateMin ? `（${t.estimateMin}分）` : ""}`);
    });
  } else {
    lines.push("今日やるタスクが見つかりませんでした。新規タスクを追加してみてください。");
  }

  lines.push("");
  lines.push("タイムテーブル案:");
  if (!plan.timeTable.length) {
    lines.push("・空き時間が少ない/タスクがないため提案できませんでした。");
  } else {
    for (const b of plan.timeTable) {
      lines.push(`・${humanTime(b.startMin)}-${humanTime(b.endMin)} ${b.type === "break" ? "☕ " : ""}${b.title}`);
    }
  }
  return lines.join("\n");
}

// Natural language quick add (very simple, Japanese-friendly)
function parseQuickAdd(input) {
  // Examples:
  // "明日 14:00 眼科" / "今日 10:30-11:30 会議" / "2/25 9:00 発表準備 60分"
  const text = (input || "").trim();
  if (!text) return null;

  const now = new Date();
  let date = new Date(now);
  let title = text;
  let startMin = null;
  let endMin = null;
  let durationMin = null;

  // Keywords
  if (text.startsWith("今日")) {
    date = new Date(now);
    title = text.replace(/^今日\s*/, "");
  } else if (text.startsWith("明日")) {
    date = addDays(now, 1);
    title = text.replace(/^明日\s*/, "");
  } else if (text.startsWith("明後日") || text.startsWith("あさって")) {
    date = addDays(now, 2);
    title = text.replace(/^(明後日|あさって)\s*/, "");
  }

  // Date like M/D or YYYY-M-D
  const mdy = title.match(/\b(\d{1,4})[/-](\d{1,2})(?:[/-](\d{1,2}))?\b/);
  if (mdy) {
    const a = parseInt(mdy[1], 10);
    const b = parseInt(mdy[2], 10);
    const c = mdy[3] ? parseInt(mdy[3], 10) : null;

    if (c == null) {
      // M/D
      date = new Date(now.getFullYear(), a - 1, b);
    } else if (a >= 1000) {
      // Y/M/D
      date = new Date(a, b - 1, c);
    } else {
      // M/D (with year omitted but accidentally matched)
      date = new Date(now.getFullYear(), a - 1, b);
    }
    title = title.replace(mdy[0], "").trim();
  }

  // Time range "HH:MM-HH:MM"
  const tr = title.match(/\b(\d{1,2}):(\d{2})\s*[-~〜]\s*(\d{1,2}):(\d{2})\b/);
  if (tr) {
    const sh = parseInt(tr[1], 10), sm = parseInt(tr[2], 10);
    const eh = parseInt(tr[3], 10), em = parseInt(tr[4], 10);
    startMin = sh * 60 + sm;
    endMin = eh * 60 + em;
    durationMin = endMin - startMin;
    title = title.replace(tr[0], "").trim();
  } else {
    // Single time "HH:MM"
    const t1 = title.match(/\b(\d{1,2}):(\d{2})\b/);
    if (t1) {
      const sh = parseInt(t1[1], 10), sm = parseInt(t1[2], 10);
      startMin = sh * 60 + sm;
      title = title.replace(t1[0], "").trim();
    }
    // Duration "60分" / "1h" / "1時間"
    const dur =
      title.match(/\b(\d{1,3})\s*分\b/) ||
      title.match(/\b(\d{1,2})\s*h\b/i) ||
      title.match(/\b(\d{1,2})\s*時間\b/);
    if (dur) {
      const v = parseInt(dur[1], 10);
      durationMin = /h|時間/i.test(dur[0]) ? v * 60 : v;
      title = title.replace(dur[0], "").trim();
    }
  }

  const dateISO = toISODate(date);
  return { dateISO, title: title || text, startMin, endMin, durationMin };
}

// -------------------- UI Components --------------------
function Icon({ name }) {
  // Minimal inline icons (emoji to keep dependencies zero)
  const map = {
    calendar: "📅",
    plus: "➕",
    search: "🔎",
    settings: "⚙️",
    logout: "🚪",
    user: "👤",
    task: "✅",
    note: "📝",
    ai: "🤖",
    spark: "✨",
    focus: "🎧",
    print: "🖨️",
    upload: "⬆️",
    download: "⬇️",
    trash: "🗑️",
    star: "⭐",
    pin: "📌",
    tag: "🏷️",
    timer: "⏱️",
    chart: "📊",
    back: "⬅️",
    next: "➡️",
    today: "📍",
  };
  return <span className="ic">{map[name] || "•"}</span>;
}

function Modal({ open, title, children, onClose, footer }) {
  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="btn ghost" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>
  );
}

function Pill({ children, tone = "neutral" }) {
  return <span className={`pill ${tone}`}>{children}</span>;
}

function Toast({ toast, onClose }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onClose, 2800);
    return () => clearTimeout(t);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className="toast">
      <div className="toast-inner">
        <div className="toast-title">{toast.title}</div>
        {toast.detail ? <div className="toast-detail">{toast.detail}</div> : null}
      </div>
    </div>
  );
}

// -------------------- Main App --------------------
export default function App() {
  const [user, setUser] = useState(null);

  // Settings
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Calendar state
  const [view, setView] = useState("month"); // month | week | day | agenda
  const [cursorDate, setCursorDate] = useState(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [selectedDateISO, setSelectedDateISO] = useState(() => toISODate(new Date()));

  // Data
  const [events, setEvents] = useState([]); // {id, title, dateISO, startMin, endMin, durationMin, tags, color, notes}
  const [tasks, setTasks] = useState([]); // {id, title, dueDate, estimateMin, priority, status, tags, notes, starred, pinned}
  const [notes, setNotes] = useState([]); // {id, dateISO, title, body}
  const [habits, setHabits] = useState([]); // {id, title, streak, log:{[dateISO]:true}}

  // UI state
  const [queryText, setQueryText] = useState("");
  const [tagFilter, setTagFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");
  const [panel, setPanel] = useState("ai"); // ai | tasks | notes | analytics | features
  const [toast, setToast] = useState(null);

  // Modals
  const [editEvent, setEditEvent] = useState(null);
  const [editTask, setEditTask] = useState(null);
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  // AI chat
  const [chatOpen, setChatOpen] = useState(true);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState([]);
  const chatEndRef = useRef(null);

  // Undo (simple)
  const undoStack = useRef([]);

  // Derived
  const allTags = useMemo(() => {
    const s = new Set();
    for (const e of events) (e.tags || []).forEach((t) => s.add(t));
    for (const t of tasks) (t.tags || []).forEach((x) => s.add(x));
    return Array.from(s).sort((a, b) => a.localeCompare(b, "ja"));
  }, [events, tasks]);

  const filteredTasks = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return tasks
      .filter((t) => (tagFilter === "all" ? true : (t.tags || []).includes(tagFilter)))
      .filter((t) => (statusFilter === "all" ? true : t.status === statusFilter))
      .filter((t) => (priorityFilter === "all" ? true : t.priority === priorityFilter))
      .filter((t) => !q ? true : (t.title || "").toLowerCase().includes(q) || (t.notes || "").toLowerCase().includes(q))
      .sort((a, b) => {
        // pinned first, then starred, then score
        const p = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
        if (p) return p;
        const s = (b.starred ? 1 : 0) - (a.starred ? 1 : 0);
        if (s) return s;
        return scoreTask(b) - scoreTask(a);
      });
  }, [tasks, queryText, tagFilter, statusFilter, priorityFilter]);

  const filteredEventsForSelectedDate = useMemo(() => {
    const q = queryText.trim().toLowerCase();
    return events
      .filter((e) => e.dateISO === selectedDateISO)
      .filter((e) => (tagFilter === "all" ? true : (e.tags || []).includes(tagFilter)))
      .filter((e) => !q ? true : (e.title || "").toLowerCase().includes(q) || (e.notes || "").toLowerCase().includes(q))
      .sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0));
  }, [events, selectedDateISO, queryText, tagFilter]);

  const todayISO = useMemo(() => toISODate(new Date()), []);

  // -------------------- Auth & Data Sync --------------------
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u || null);
      if (!u) return;

      // Load settings
      const settingsRef = doc(db, "users", u.uid, "meta", "settings");
      const snap = await getDoc(settingsRef);
      if (snap.exists()) {
        setSettings((prev) => ({ ...prev, ...snap.data() }));
      } else {
        await setDoc(settingsRef, { ...DEFAULT_SETTINGS, createdAt: serverTimestamp() });
      }

      // Subscribe collections
      const base = (col) => collection(db, "users", u.uid, col);

      const unsubEvents = onSnapshot(
        query(base("events"), orderBy("dateISO", "desc")),
        (qs) => setEvents(qs.docs.map((d) => ({ id: d.id, ...d.data() })))
      );
      const unsubTasks = onSnapshot(
        query(base("tasks"), orderBy("updatedAt", "desc")),
        (qs) => setTasks(qs.docs.map((d) => ({ id: d.id, ...d.data() })))
      );
      const unsubNotes = onSnapshot(
        query(base("notes"), orderBy("dateISO", "desc")),
        (qs) => setNotes(qs.docs.map((d) => ({ id: d.id, ...d.data() })))
      );
      const unsubHabits = onSnapshot(
        query(base("habits"), orderBy("title", "asc")),
        (qs) => setHabits(qs.docs.map((d) => ({ id: d.id, ...d.data() })))
      );
      const unsubChat = onSnapshot(
        query(base("chat"), orderBy("createdAt", "asc")),
        (qs) => {
          const msgs = qs.docs.map((d) => ({ id: d.id, ...d.data() }));
          setChatMessages(msgs);
        }
      );

      // Cleanup
      return () => {
        unsubEvents();
        unsubTasks();
        unsubNotes();
        unsubHabits();
        unsubChat();
      };
    });

    return () => unsub();
  }, []);

  // scroll chat end
  useEffect(() => {
    if (!chatEndRef.current) return;
    chatEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chatMessages.length, chatOpen]);

  // Persist settings when changed
  useEffect(() => {
    if (!user) return;
    const t = setTimeout(async () => {
      try {
        await setDoc(doc(db, "users", user.uid, "meta", "settings"), { ...settings, updatedAt: serverTimestamp() }, { merge: true });
      } catch (e) {
        console.warn(e);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [settings, user]);

  // -------------------- Actions --------------------
  async function login() {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
  }
  async function logout() {
    await signOut(auth);
  }

  function pushUndo(action) {
    undoStack.current.push(action);
    if (undoStack.current.length > 25) undoStack.current.shift();
  }
  async function undo() {
    const last = undoStack.current.pop();
    if (!last) {
      setToast({ title: "Undoするものがありません" });
      return;
    }
    await last();
    setToast({ title: "Undoしました" });
  }

  async function upsertEvent(e) {
    if (!user) return;
    const col = collection(db, "users", user.uid, "events");
    if (!e.id) {
      const payload = { ...e, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
      delete payload.id;
      const ref = await addDoc(col, payload);
      pushUndo(async () => deleteDoc(doc(db, "users", user.uid, "events", ref.id)));
      setToast({ title: "イベントを追加しました" });
    } else {
      const id = e.id;
      const prev = events.find((x) => x.id === id);
      await updateDoc(doc(db, "users", user.uid, "events", id), { ...e, updatedAt: serverTimestamp() });
      if (prev) pushUndo(async () => updateDoc(doc(db, "users", user.uid, "events", id), prev));
      setToast({ title: "イベントを更新しました" });
    }
  }

  async function deleteEventById(id) {
    if (!user) return;
    const prev = events.find((x) => x.id === id);
    await deleteDoc(doc(db, "users", user.uid, "events", id));
    if (prev) pushUndo(async () => setDoc(doc(db, "users", user.uid, "events", id), prev));
    setToast({ title: "イベントを削除しました" });
  }

  async function upsertTask(t) {
    if (!user) return;
    const col = collection(db, "users", user.uid, "tasks");
    const payload = { ...t, updatedAt: serverTimestamp() };
    if (!t.id) {
      payload.createdAt = serverTimestamp();
      delete payload.id;
      const ref = await addDoc(col, payload);
      pushUndo(async () => deleteDoc(doc(db, "users", user.uid, "tasks", ref.id)));
      setToast({ title: "タスクを追加しました" });
    } else {
      const id = t.id;
      const prev = tasks.find((x) => x.id === id);
      await updateDoc(doc(db, "users", user.uid, "tasks", id), payload);
      if (prev) pushUndo(async () => updateDoc(doc(db, "users", user.uid, "tasks", id), prev));
      setToast({ title: "タスクを更新しました" });
    }
  }

  async function deleteTaskById(id) {
    if (!user) return;
    const prev = tasks.find((x) => x.id === id);
    await deleteDoc(doc(db, "users", user.uid, "tasks", id));
    if (prev) pushUndo(async () => setDoc(doc(db, "users", user.uid, "tasks", id), prev));
    setToast({ title: "タスクを削除しました" });
  }

  async function addNote(note) {
    if (!user) return;
    const col = collection(db, "users", user.uid, "notes");
    const payload = { ...note, createdAt: serverTimestamp(), updatedAt: serverTimestamp() };
    const ref = await addDoc(col, payload);
    pushUndo(async () => deleteDoc(doc(db, "users", user.uid, "notes", ref.id)));
    setToast({ title: "ノートを追加しました" });
  }

  async function sendChat(role, content, meta = {}) {
    if (!user) return;
    const col = collection(db, "users", user.uid, "chat");
    await addDoc(col, {
      role,
      content,
      meta,
      createdAt: serverTimestamp(),
    });
  }

  function localAIRespond(userText) {
    // Very simple assistant logic
    const t = (userText || "").trim();
    if (!t) return "どうしましたか？「今日何する？」や「予定を追加: 明日 10:00 会議」など言ってみてください。";

    const lower = t.toLowerCase();

    if (t.includes("今日") && (t.includes("何") || t.includes("なに") || t.includes("する"))) {
      const plan = buildTodaysPlan({ dateISO: todayISO, tasks, events, settings });
      return formatPlanToText(plan);
    }
    if (lower.startsWith("help") || t.includes("使い方") || t.includes("ヘルプ")) {
      return [
        "できること例:",
        "・「今日何する？」→ 今日のおすすめプランを作ります",
        "・「予定追加: 明日 10:00-11:00 会議」→ 予定を作成（※このデモでは提案のみ。実行はボタンで）",
        "・「タスク追加: 2/25 発表準備 90分 期限 2/28」→ タスク案を作成",
        "・「優先順位」→ 上位タスクの並び替えを提案",
      ].join("\n");
    }
    if (t.includes("優先") || t.includes("順番")) {
      const top = tasks
        .filter((x) => x.status !== "done")
        .slice()
        .sort((a, b) => scoreTask(b) - scoreTask(a))
        .slice(0, 10);
      if (!top.length) return "未完了タスクがありません。";
      const lines = ["優先順位（上位）:"];
      top.forEach((x, i) => lines.push(`${i + 1}. ${x.title}${x.dueDate ? `（期限:${x.dueDate}）` : ""}${x.estimateMin ? `（${x.estimateMin}分）` : ""}`));
      return lines.join("\n");
    }
    if (t.startsWith("予定追加:") || t.startsWith("予定:")) {
      const payload = parseQuickAdd(t.replace(/^予定追加:|^予定:/, "").trim());
      if (!payload) return "読み取れませんでした。例: 予定追加: 明日 10:00-11:00 会議";
      return [
        "予定案を作りました（確認して「追加」ボタンを押してください）:",
        `・日付: ${payload.dateISO}`,
        `・タイトル: ${payload.title}`,
        payload.startMin != null ? `・開始: ${humanTime(payload.startMin)}` : "・開始: 未指定",
        payload.durationMin ? `・長さ: ${payload.durationMin}分` : "・長さ: 未指定",
        "",
        "👉 右の「クイック追加」から同じ内容を貼るとすぐ作れます。",
      ].join("\n");
    }
    if (t.startsWith("タスク追加:") || t.startsWith("タスク:")) {
      const body = t.replace(/^タスク追加:|^タスク:/, "").trim();
      // rough parse due date keywords
      const dueMatch = body.match(/期限[:：]?\s*(\d{1,4}[/-]\d{1,2}(?:[/-]\d{1,2})?)/);
      const estMatch = body.match(/(\d{1,3})\s*分/);
      const due = dueMatch ? dueMatch[1].includes("/") ? dueMatch[1] : dueMatch[1].replace(/-/g, "/") : null;
      const est = estMatch ? parseInt(estMatch[1], 10) : null;
      return [
        "タスク案:",
        `・タイトル: ${body.replace(/期限[:：].*$/, "").trim()}`,
        due ? `・期限: ${due}` : "・期限: 未指定",
        est ? `・見積: ${est}分` : "・見積: 未指定",
        "👉 「タスク」タブの + から追加できます。",
      ].join("\n");
    }

    // Default: give actionable suggestions based on context
    const plan = buildTodaysPlan({ dateISO: selectedDateISO, tasks, events, settings });
    return [
      "了解です。今の状況から、次が良さそうです:",
      plan.top3.length ? `・まずは「${plan.top3[0].title}」から（小さく始める）` : "・タスクを1つ追加して、見積（分）と期限を入れる",
      "・大きいタスクは15〜30分の小タスクに分割する",
      "・予定が詰まっている日は「今日の必須3つ」だけに絞る",
      "",
      "「今日何する？」と送ると、今日の時間割を作ります。",
    ].join("\n");
  }

  async function onSendChat() {
    const t = chatInput.trim();
    if (!t) return;
    setChatInput("");
    await sendChat("user", t);

    // local AI response
    const answer = localAIRespond(t);
    await sendChat("assistant", answer, { local: true });
  }

  async function onAskDailyPlan() {
    const plan = buildTodaysPlan({ dateISO: todayISO, tasks, events, settings });
    const text = formatPlanToText(plan);
    await sendChat("assistant", text, { local: true, daily: true });
    setPanel("ai");
    setChatOpen(true);
  }

  async function quickAdd(text) {
    const p = parseQuickAdd(text);
    if (!p) {
      setToast({ title: "クイック追加に失敗しました", detail: "例: 明日 10:00-11:00 会議" });
      return;
    }
    // If time is present -> event, else task
    if (p.startMin != null) {
      await upsertEvent({
        title: p.title,
        dateISO: p.dateISO,
        startMin: p.startMin,
        durationMin: p.durationMin || settings.defaultEventDurationMin,
        endMin: p.endMin ?? (p.startMin + (p.durationMin || settings.defaultEventDurationMin)),
        tags: [],
        color: "blue",
        notes: "",
      });
      setSelectedDateISO(p.dateISO);
      setCursorDate(parseISODate(p.dateISO));
      setView("day");
      return;
    }
    await upsertTask({
      title: p.title,
      dueDate: p.dateISO,
      estimateMin: p.durationMin || settings.defaultTaskEstimateMin,
      priority: "normal",
      status: "todo",
      tags: [],
      notes: "",
      starred: false,
      pinned: false,
    });
    setToast({ title: "タスクを追加しました（クイック）" });
  }

  // -------------------- Calendar range computation --------------------
  const monthGrid = useMemo(() => {
    const monthStart = startOfMonth(cursorDate);
    const gridStart = startOfWeek(monthStart, settings.weekStartsOnMonday);
    const monthEnd = endOfMonth(cursorDate);
    const gridEnd = addDays(startOfWeek(addDays(monthEnd, 7), settings.weekStartsOnMonday), -1);
    const days = [];
    let cur = new Date(gridStart);
    while (cur <= gridEnd) {
      days.push(new Date(cur));
      cur = addDays(cur, 1);
    }
    return days;
  }, [cursorDate, settings.weekStartsOnMonday]);

  const weekDays = useMemo(() => {
    const start = startOfWeek(parseISODate(selectedDateISO), settings.weekStartsOnMonday);
    return Array.from({ length: 7 }).map((_, i) => addDays(start, i));
  }, [selectedDateISO, settings.weekStartsOnMonday]);

  // -------------------- Analytics (simple) --------------------
  const analytics = useMemo(() => {
    const done = tasks.filter((t) => t.status === "done").length;
    const total = tasks.length || 1;
    const completionRate = Math.round((done / total) * 100);

    // minutes scheduled today from tasks and events
    const todayEvents = events.filter((e) => e.dateISO === todayISO);
    const eventMin = todayEvents.reduce((sum, e) => sum + (e.durationMin || (e.endMin - e.startMin) || 0), 0);

    const doneMinutes = tasks
      .filter((t) => t.status === "done")
      .reduce((sum, t) => sum + (t.actualMin || 0), 0);

    // tag counts
    const tagCount = {};
    for (const t of tasks) {
      (t.tags || []).forEach((x) => (tagCount[x] = (tagCount[x] || 0) + 1));
    }

    return { completionRate, eventMin, doneMinutes, tagCount };
  }, [tasks, events, todayISO]);

  // -------------------- Render Helpers --------------------
  function headerLabel() {
    const d = cursorDate;
    return `${d.getFullYear()}年 ${d.getMonth() + 1}月`;
  }

  function navigate(delta) {
    if (view === "month") setCursorDate((d) => addMonths(d, delta));
    else setSelectedDateISO((iso) => toISODate(addDays(parseISODate(iso), delta * (view === "week" ? 7 : 1))));
  }

  function goToday() {
    const d = new Date();
    setCursorDate(d);
    setSelectedDateISO(toISODate(d));
  }

  function openNewEvent(dateISO) {
    setEditEvent({
      id: null,
      title: "",
      dateISO,
      startMin: settings.workingHours.start * 60,
      durationMin: settings.defaultEventDurationMin,
      endMin: settings.workingHours.start * 60 + settings.defaultEventDurationMin,
      tags: [],
      color: "blue",
      notes: "",
    });
  }
  function openNewTask() {
    setEditTask({
      id: null,
      title: "",
      dueDate: selectedDateISO,
      estimateMin: settings.defaultTaskEstimateMin,
      priority: "normal",
      status: "todo",
      tags: [],
      notes: "",
      starred: false,
      pinned: false,
      difficulty: "medium",
    });
  }

  function exportJSON() {
    const data = { version: 1, exportedAt: new Date().toISOString(), settings, events, tasks, notes, habits };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "super-planner-backup.json";
    a.click();
    URL.revokeObjectURL(url);
    setToast({ title: "バックアップを書き出しました" });
  }

  async function importJSON(file) {
    if (!file || !user) return;
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data || !data.version) throw new Error("Invalid backup file");

    // (Simple restore) Create new docs
    const base = (col) => collection(db, "users", user.uid, col);

    if (data.settings) setSettings((prev) => ({ ...prev, ...data.settings }));
    const pushAll = async (colName, items) => {
      if (!Array.isArray(items)) return;
      for (const it of items) {
        const payload = { ...it };
        delete payload.id;
        payload.restoredAt = serverTimestamp();
        await addDoc(base(colName), payload);
      }
    };
    await pushAll("events", data.events);
    await pushAll("tasks", data.tasks);
    await pushAll("notes", data.notes);
    await pushAll("habits", data.habits);

    setToast({ title: "復元しました（重複に注意）" });
  }

  function printView() {
    window.print();
  }

  // -------------------- UI --------------------
  if (!user) {
    return (
      <div className="app-root">
        <GlobalStyles theme={settings.theme} density={settings.density} />
        <div className="auth-screen">
          <div className="auth-card">
            <div className="auth-title">Super Planner</div>
            <div className="auth-sub">
              Googleカレンダー風UI + タスク + AI相談（ローカル）
            </div>
            <button className="btn primary" onClick={login}>
              <Icon name="user" /> Googleでログイン
            </button>
            <div className="auth-foot">
              ※Firebase Auth（Google）を有効にしてください
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app-root ${settings.theme === "dark" ? "dark" : ""}`}>
      <GlobalStyles theme={settings.theme} density={settings.density} />
      <Toast toast={toast} onClose={() => setToast(null)} />

      {/* Topbar */}
      <div className="topbar">
        <div className="left">
          <div className="brand" onClick={() => setPanel("ai")}>
            <Icon name="calendar" /> Super Planner
          </div>

          <button className="btn ghost" onClick={() => navigate(-1)} title="前へ">
            <Icon name="back" />
          </button>
          <button className="btn ghost" onClick={goToday} title="今日へ">
            <Icon name="today" /> 今日
          </button>
          <button className="btn ghost" onClick={() => navigate(1)} title="次へ">
            <Icon name="next" />
          </button>

          <div className="title">{view === "month" ? headerLabel() : selectedDateISO}</div>

          <div className="view-tabs">
            {["month", "week", "day", "agenda"].map((v) => (
              <button
                key={v}
                className={`tab ${view === v ? "active" : ""}`}
                onClick={() => setView(v)}
              >
                {v === "month" ? "月" : v === "week" ? "週" : v === "day" ? "日" : "一覧"}
              </button>
            ))}
          </div>
        </div>

        <div className="right">
          <div className="search">
            <Icon name="search" />
            <input
              value={queryText}
              onChange={(e) => setQueryText(e.target.value)}
              placeholder="検索（予定/タスク/ノート）"
            />
          </div>

          <button className="btn ghost" onClick={() => setQuickAddOpen(true)} title="クイック追加">
            <Icon name="plus" /> 追加
          </button>

          <button className="btn ghost" onClick={printView} title="印刷">
            <Icon name="print" />
          </button>

          <button className="btn ghost" onClick={() => setSettingsOpen(true)} title="設定">
            <Icon name="settings" />
          </button>

          <button className="btn ghost" onClick={undo} title="Undo">
            ↩ Undo
          </button>

          <button className="btn ghost" onClick={logout} title="ログアウト">
            <Icon name="logout" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="body">
        {/* Sidebar */}
        <div className="sidebar">
          <div className="userbox">
            <div className="avatar">{(user.displayName || "U")[0]}</div>
            <div className="usertext">
              <div className="name">{user.displayName || "User"}</div>
              <div className="mail">{user.email}</div>
            </div>
          </div>

          <div className="side-section">
            <div className="side-title">スマート</div>
            <button className={`side-item ${panel === "ai" ? "active" : ""}`} onClick={() => setPanel("ai")}>
              <Icon name="ai" /> AI相談
              <span className="grow" />
              <Pill tone="blue">β</Pill>
            </button>
            <button className={`side-item ${panel === "tasks" ? "active" : ""}`} onClick={() => setPanel("tasks")}>
              <Icon name="task" /> タスク
            </button>
            <button className={`side-item ${panel === "notes" ? "active" : ""}`} onClick={() => setPanel("notes")}>
              <Icon name="note" /> ノート
            </button>
            <button className={`side-item ${panel === "analytics" ? "active" : ""}`} onClick={() => setPanel("analytics")}>
              <Icon name="chart" /> 分析
            </button>
            <button className={`side-item ${panel === "features" ? "active" : ""}`} onClick={() => setPanel("features")}>
              <Icon name="spark" /> 機能一覧
            </button>
          </div>

          <div className="side-section">
            <div className="side-title">フィルタ</div>
            <div className="filter-row">
              <label>タグ</label>
              <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)}>
                <option value="all">すべて</option>
                {allTags.map((t) => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>
            <div className="filter-row">
              <label>状態</label>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                <option value="all">すべて</option>
                <option value="todo">未着手</option>
                <option value="doing">進行中</option>
                <option value="done">完了</option>
              </select>
            </div>
            <div className="filter-row">
              <label>優先</label>
              <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>
                <option value="all">すべて</option>
                <option value="low">低</option>
                <option value="normal">中</option>
                <option value="high">高</option>
                <option value="critical">最優先</option>
              </select>
            </div>
          </div>

          <div className="side-section">
            <div className="side-title">データ</div>
            <button className="btn ghost full" onClick={exportJSON}>
              <Icon name="download" /> バックアップ(JSON)
            </button>
            <label className="btn ghost full">
              <Icon name="upload" /> 復元(JSON)
              <input
                type="file"
                accept="application/json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  importJSON(f).catch((err) => setToast({ title: "復元に失敗", detail: String(err.message || err) }));
                  e.target.value = "";
                }}
              />
            </label>
          </div>

          <div className="side-section">
            <div className="side-title">今日のAI</div>
            <button className="btn primary full" onClick={onAskDailyPlan}>
              <Icon name="spark" /> 今日なにする？
            </button>
            <div className="mini-hint">
              今日のタスク・予定から、時間割を自動で提案します。
            </div>
          </div>
        </div>

        {/* Main */}
        <div className="main">
          {view === "month" ? (
            <MonthView
              days={monthGrid}
              cursorDate={cursorDate}
              selectedDateISO={selectedDateISO}
              onSelectDate={(iso) => {
                setSelectedDateISO(iso);
                setView("day");
              }}
              events={events}
              tasks={tasks}
              onNewEvent={(iso) => openNewEvent(iso)}
              settings={settings}
            />
          ) : view === "week" ? (
            <WeekView
              days={weekDays}
              selectedDateISO={selectedDateISO}
              onSelectDate={(iso) => setSelectedDateISO(iso)}
              events={events}
              tasks={tasks}
              onNewEvent={(iso) => openNewEvent(iso)}
              onEditEvent={(ev) => setEditEvent(ev)}
              settings={settings}
            />
          ) : view === "day" ? (
            <DayView
              dateISO={selectedDateISO}
              events={filteredEventsForSelectedDate}
              tasks={filteredTasks}
              onNewEvent={() => openNewEvent(selectedDateISO)}
              onEditEvent={(ev) => setEditEvent(ev)}
              onNewTask={openNewTask}
              onEditTask={(t) => setEditTask(t)}
              onToggleTaskStatus={(t) => upsertTask({ ...t, status: t.status === "done" ? "todo" : "done" })}
              settings={settings}
            />
          ) : (
            <AgendaView
              cursorDate={cursorDate}
              events={events}
              tasks={filteredTasks}
              onEditEvent={(ev) => setEditEvent(ev)}
              onEditTask={(t) => setEditTask(t)}
            />
          )}
        </div>

        {/* Right panel */}
        <div className="rightpanel">
          {panel === "ai" ? (
            <AIChatPanel
              open={chatOpen}
              onToggle={() => setChatOpen((x) => !x)}
              messages={chatMessages}
              input={chatInput}
              setInput={setChatInput}
              onSend={onSendChat}
              endRef={chatEndRef}
              onQuickAdd={() => setQuickAddOpen(true)}
            />
          ) : panel === "tasks" ? (
            <TasksPanel
              tasks={filteredTasks}
              onNew={openNewTask}
              onEdit={setEditTask}
              onDelete={deleteTaskById}
              onToggleStar={(t) => upsertTask({ ...t, starred: !t.starred })}
              onTogglePin={(t) => upsertTask({ ...t, pinned: !t.pinned })}
              onSetStatus={(t, status) => upsertTask({ ...t, status })}
            />
          ) : panel === "notes" ? (
            <NotesPanel
              notes={notes}
              selectedDateISO={selectedDateISO}
              onAdd={(n) => addNote(n)}
            />
          ) : panel === "analytics" ? (
            <AnalyticsPanel analytics={analytics} allTags={allTags} />
          ) : (
            <FeaturesPanel />
          )}

          <div className="panel-footer">
            <div className="small">
              保存: 自動（Firebase） / Undo: 最大25手
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        setSettings={setSettings}
      />

      <QuickAddModal
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onSubmit={(txt) => {
          setQuickAddOpen(false);
          quickAdd(txt);
        }}
      />

      <EventModal
        open={!!editEvent}
        event={editEvent}
        onClose={() => setEditEvent(null)}
        onSave={(ev) => {
          setEditEvent(null);
          upsertEvent(ev);
        }}
        onDelete={(id) => {
          setEditEvent(null);
          deleteEventById(id);
        }}
      />

      <TaskModal
        open={!!editTask}
        task={editTask}
        onClose={() => setEditTask(null)}
        onSave={(t) => {
          setEditTask(null);
          upsertTask(t);
        }}
        onDelete={(id) => {
          setEditTask(null);
          deleteTaskById(id);
        }}
      />
    </div>
  );
}

// -------------------- Views --------------------
function MonthView({ days, cursorDate, selectedDateISO, onSelectDate, events, tasks, onNewEvent, settings }) {
  const month = cursorDate.getMonth();
  const dayEvents = useMemo(() => {
    const map = {};
    for (const e of events) {
      map[e.dateISO] = map[e.dateISO] || [];
      map[e.dateISO].push(e);
    }
    return map;
  }, [events]);

  const dayTasks = useMemo(() => {
    const map = {};
    for (const t of tasks) {
      const key = t.dueDate || t.scheduledDateISO;
      if (!key) continue;
      map[key] = map[key] || [];
      map[key].push(t);
    }
    return map;
  }, [tasks]);

  const headerDays = settings.weekStartsOnMonday
    ? ["月", "火", "水", "木", "金", "土", "日"]
    : ["日", "月", "火", "水", "木", "金", "土"];

  return (
    <div className="view month">
      <div className="month-header-row">
        {headerDays.map((x) => (
          <div key={x} className="month-header-cell">{x}</div>
        ))}
      </div>
      <div className="month-grid">
        {days.map((d) => {
          const iso = toISODate(d);
          const isThisMonth = d.getMonth() === month;
          const isSelected = iso === selectedDateISO;
          const isToday = iso === toISODate(new Date());
          const es = (dayEvents[iso] || []).slice().sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0)).slice(0, 3);
          const ts = (dayTasks[iso] || []).filter((t) => t.status !== "done").slice(0, 2);

          return (
            <div
              key={iso}
              className={`month-cell ${isThisMonth ? "" : "dim"} ${isSelected ? "selected" : ""} ${isToday ? "today" : ""}`}
              onClick={() => onSelectDate(iso)}
              onDoubleClick={() => onNewEvent(iso)}
              title="クリック:日表示 / ダブルクリック:イベント作成"
            >
              <div className="month-date">
                <span className="num">{d.getDate()}</span>
              </div>

              <div className="month-items">
                {es.map((e) => (
                  <div key={e.id} className={`chip chip-${e.color || "blue"}`}>
                    {e.startMin != null ? humanTime(e.startMin) + " " : ""}{e.title}
                  </div>
                ))}
                {ts.map((t) => (
                  <div key={t.id} className={`chip chip-task`}>
                    ✅ {t.title}
                  </div>
                ))}
                {(dayEvents[iso] || []).length + (dayTasks[iso] || []).length > 5 ? (
                  <div className="chip chip-more">…</div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="hint-row">
        <div className="hint">ダブルクリックでイベント作成 / 右のAIで「今日なにする？」</div>
      </div>
    </div>
  );
}

function WeekView({ days, selectedDateISO, onSelectDate, events, tasks, onNewEvent, onEditEvent, settings }) {
  const byDay = useMemo(() => {
    const map = {};
    for (const e of events) {
      map[e.dateISO] = map[e.dateISO] || [];
      map[e.dateISO].push(e);
    }
    for (const k of Object.keys(map)) map[k].sort((a, b) => (a.startMin ?? 0) - (b.startMin ?? 0));
    return map;
  }, [events]);

  const tasksByDay = useMemo(() => {
    const map = {};
    for (const t of tasks) {
      const key = t.dueDate || t.scheduledDateISO;
      if (!key) continue;
      map[key] = map[key] || [];
      map[key].push(t);
    }
    return map;
  }, [tasks]);

  const hours = Array.from({ length: 24 }).map((_, i) => i);

  return (
    <div className="view week">
      <div className="week-head">
        <div className="week-col hour-col" />
        {days.map((d) => {
          const iso = toISODate(d);
          const isSelected = iso === selectedDateISO;
          const isToday = iso === toISODate(new Date());
          return (
            <div
              key={iso}
              className={`week-col day-head ${isSelected ? "selected" : ""} ${isToday ? "today" : ""}`}
              onClick={() => onSelectDate(iso)}
              onDoubleClick={() => onNewEvent(iso)}
              title="クリック:選択 / ダブルクリック:新規イベント"
            >
              <div className="week-dow">{WEEKDAY_JA[d.getDay()]}</div>
              <div className="week-date">{d.getMonth() + 1}/{d.getDate()}</div>
              <div className="week-mini">
                {(tasksByDay[iso] || []).filter((t) => t.status !== "done").slice(0, 2).map((t) => (
                  <div key={t.id} className="mini-task">✅ {t.title}</div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <div className="week-grid">
        <div className="week-col hour-col">
          {hours.map((h) => (
            <div key={h} className="hour-cell">{pad2(h)}:00</div>
          ))}
        </div>

        {days.map((d) => {
          const iso = toISODate(d);
          const es = (byDay[iso] || []);
          return (
            <div key={iso} className="week-col day-col">
              {hours.map((h) => (
                <div key={h} className={`slot ${h >= settings.workingHours.start && h < settings.workingHours.end ? "" : "off"}`} />
              ))}
              {es.map((e) => {
                const top = ((e.startMin ?? 0) / (24 * 60)) * 100;
                const height = (((e.durationMin ?? (e.endMin - e.startMin) ?? 60)) / (24 * 60)) * 100;
                return (
                  <div
                    key={e.id}
                    className={`event-block ev-${e.color || "blue"}`}
                    style={{ top: `${top}%`, height: `${height}%` }}
                    onClick={() => onEditEvent(e)}
                    title="クリックで編集"
                  >
                    <div className="event-title">{e.title}</div>
                    <div className="event-time">{e.startMin != null ? humanTime(e.startMin) : ""}</div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DayView({
  dateISO,
  events,
  tasks,
  onNewEvent,
  onEditEvent,
  onNewTask,
  onEditTask,
  onToggleTaskStatus,
  settings,
}) {
  const dayTasks = useMemo(() => {
    const q = tasks
      .filter((t) => t.status !== "done")
      .filter((t) => (t.scheduledDateISO ? t.scheduledDateISO === dateISO : (t.dueDate ? t.dueDate === dateISO : true)))
      .slice()
      .sort((a, b) => scoreTask(b) - scoreTask(a));
    return q;
  }, [tasks, dateISO]);

  const plan = useMemo(() => buildTodaysPlan({ dateISO, tasks, events, settings }), [dateISO, tasks, events, settings]);

  return (
    <div className="view day">
      <div className="day-top">
        <div className="day-title">{dateISO}</div>
        <div className="day-actions">
          <button className="btn primary" onClick={onNewEvent}>
            <Icon name="plus" /> 予定
          </button>
          <button className="btn ghost" onClick={onNewTask}>
            <Icon name="plus" /> タスク
          </button>
        </div>
      </div>

      <div className="day-columns">
        <div className="day-col">
          <div className="section-title">予定（{events.length}）</div>
          {events.length ? (
            <div className="list">
              {events.map((e) => (
                <div key={e.id} className="list-item" onClick={() => onEditEvent(e)}>
                  <div className={`dot dot-${e.color || "blue"}`} />
                  <div className="li-main">
                    <div className="li-title">{e.title}</div>
                    <div className="li-sub">
                      {e.startMin != null ? humanTime(e.startMin) : "未指定"}{" "}
                      {e.endMin != null ? `- ${humanTime(e.endMin)}` : ""}
                      {e.tags?.length ? ` · ${e.tags.join(", ")}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">予定がありません（＋で追加）</div>
          )}

          <div className="section-title">AIタイムブロック案</div>
          <div className="planbox">
            {plan.timeTable.length ? (
              plan.timeTable.slice(0, 14).map((b, idx) => (
                <div key={idx} className={`planrow ${b.type}`}>
                  <div className="pt">{humanTime(b.startMin)}-{humanTime(b.endMin)}</div>
                  <div className="ptt">{b.type === "break" ? "☕ " : ""}{b.title}</div>
                </div>
              ))
            ) : (
              <div className="empty">提案できる枠がありません（勤務時間/予定を調整してみてください）</div>
            )}
          </div>
        </div>

        <div className="day-col">
          <div className="section-title">今日のタスク候補</div>
          {dayTasks.length ? (
            <div className="list">
              {dayTasks.slice(0, 18).map((t) => (
                <div key={t.id} className="list-item">
                  <input
                    type="checkbox"
                    checked={t.status === "done"}
                    onChange={() => onToggleTaskStatus(t)}
                    title="完了にする"
                  />
                  <div className="li-main clickable" onClick={() => onEditTask(t)}>
                    <div className="li-title">
                      {t.pinned ? "📌 " : ""}{t.starred ? "⭐ " : ""}{t.title}
                    </div>
                    <div className="li-sub">
                      {t.dueDate ? `期限:${t.dueDate}` : "期限なし"}
                      {" · "}
                      {t.estimateMin ? `${t.estimateMin}分` : "見積なし"}
                      {" · "}
                      {t.priority || "normal"}
                      {t.tags?.length ? ` · ${t.tags.join(", ")}` : ""}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">タスク候補がありません（右のタスクから追加）</div>
          )}
        </div>
      </div>
    </div>
  );
}

function AgendaView({ cursorDate, events, tasks, onEditEvent, onEditTask }) {
  const rows = useMemo(() => {
    const start = startOfWeek(startOfMonth(cursorDate), true);
    const end = addDays(start, 60);

    const list = [];
    // events
    for (const e of events) {
      const d = parseISODate(e.dateISO);
      if (d < start || d > end) continue;
      list.push({ type: "event", dateISO: e.dateISO, startMin: e.startMin ?? 0, title: e.title, ref: e });
    }
    // tasks
    for (const t of tasks) {
      const key = t.dueDate || t.scheduledDateISO;
      if (!key) continue;
      const d = parseISODate(key);
      if (d < start || d > end) continue;
      list.push({ type: "task", dateISO: key, startMin: 24 * 60 - 1, title: t.title, ref: t });
    }
    list.sort((a, b) => (a.dateISO === b.dateISO ? a.startMin - b.startMin : a.dateISO.localeCompare(b.dateISO)));
    return list;
  }, [events, tasks, cursorDate]);

  return (
    <div className="view agenda">
      <div className="section-title">一覧（直近60日）</div>
      <div className="list">
        {rows.map((r, idx) => (
          <div
            key={idx}
            className="list-item clickable"
            onClick={() => (r.type === "event" ? onEditEvent(r.ref) : onEditTask(r.ref))}
          >
            <div className={`dot ${r.type === "event" ? "dot-blue" : "dot-green"}`} />
            <div className="li-main">
              <div className="li-title">{r.title}</div>
              <div className="li-sub">
                {r.dateISO}{" "}
                {r.type === "event" ? (r.startMin ? `· ${humanTime(r.startMin)}` : "") : "· 期限/予定"}
              </div>
            </div>
            <Pill tone={r.type === "event" ? "blue" : "green"}>{r.type === "event" ? "予定" : "タスク"}</Pill>
          </div>
        ))}
        {!rows.length ? <div className="empty">データがありません</div> : null}
      </div>
    </div>
  );
}

// -------------------- Panels --------------------
function AIChatPanel({ open, onToggle, messages, input, setInput, onSend, endRef, onQuickAdd }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="ai" /> AI相談</div>
        <div className="panel-actions">
          <button className="btn ghost" onClick={onQuickAdd}><Icon name="plus" /> クイック追加</button>
          <button className="btn ghost" onClick={onToggle}>{open ? "閉じる" : "開く"}</button>
        </div>
      </div>

      {open ? (
        <>
          <div className="chat">
            {messages.map((m) => (
              <div key={m.id} className={`chat-msg ${m.role}`}>
                <div className="bubble">
                  <pre className="bubble-text">{m.content}</pre>
                </div>
              </div>
            ))}
            <div ref={endRef} />
          </div>

          <div className="chat-input">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              rows={3}
              placeholder="例: 今日何する？ / 優先順位 / 予定追加: 明日 10:00-11:00 会議"
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") onSend();
              }}
            />
            <button className="btn primary" onClick={onSend}>送信</button>
          </div>

          <div className="small tip">
            ヒント: Ctrl/⌘ + Enterで送信。ローカルAIなので、まずは「今日何する？」が一番おすすめ。
          </div>
        </>
      ) : (
        <div className="empty">AIチャットを開くと、計画づくりを一緒にできます。</div>
      )}
    </div>
  );
}

function TasksPanel({ tasks, onNew, onEdit, onDelete, onToggleStar, onTogglePin, onSetStatus }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="task" /> タスク</div>
        <div className="panel-actions">
          <button className="btn primary" onClick={onNew}><Icon name="plus" /> 追加</button>
        </div>
      </div>

      <div className="list dense">
        {tasks.slice(0, 200).map((t) => (
          <div key={t.id} className="list-item">
            <button className="btn ghost" onClick={() => onTogglePin(t)} title="ピン留め"><Icon name="pin" /></button>
            <button className="btn ghost" onClick={() => onToggleStar(t)} title="スター"><Icon name="star" /></button>
            <div className="li-main clickable" onClick={() => onEdit(t)}>
              <div className="li-title">
                {t.pinned ? "📌 " : ""}{t.starred ? "⭐ " : ""}{t.title}
              </div>
              <div className="li-sub">
                {t.status || "todo"} · {t.priority || "normal"} · {t.estimateMin ? `${t.estimateMin}分` : "見積なし"}
                {t.dueDate ? ` · 期限:${t.dueDate}` : ""}
              </div>
            </div>
            <select value={t.status || "todo"} onChange={(e) => onSetStatus(t, e.target.value)} title="状態">
              <option value="todo">未</option>
              <option value="doing">進</option>
              <option value="done">完</option>
            </select>
            <button className="btn ghost" onClick={() => onDelete(t.id)} title="削除"><Icon name="trash" /></button>
          </div>
        ))}
        {!tasks.length ? <div className="empty">タスクがありません</div> : null}
      </div>
    </div>
  );
}

function NotesPanel({ notes, selectedDateISO, onAdd }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="note" /> ノート</div>
      </div>

      <div className="note-editor">
        <div className="row">
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="タイトル（任意）" />
          <button
            className="btn primary"
            onClick={() => {
              onAdd({ dateISO: selectedDateISO, title: title || "メモ", body });
              setTitle("");
              setBody("");
            }}
          >
            追加
          </button>
        </div>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={6} placeholder="内容…" />
        <div className="small">※選択中の日付（{selectedDateISO}）に保存します</div>
      </div>

      <div className="section-title">最近のノート</div>
      <div className="list dense">
        {notes.slice(0, 60).map((n) => (
          <div key={n.id} className="list-item">
            <div className="li-main">
              <div className="li-title">{n.title || "メモ"}</div>
              <div className="li-sub">{n.dateISO}</div>
              <div className="li-sub pre">{(n.body || "").slice(0, 180)}{(n.body || "").length > 180 ? "…" : ""}</div>
            </div>
          </div>
        ))}
        {!notes.length ? <div className="empty">ノートがありません</div> : null}
      </div>
    </div>
  );
}

function AnalyticsPanel({ analytics, allTags }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="chart" /> 分析</div>
      </div>

      <div className="cards">
        <div className="card">
          <div className="card-k">タスク完了率</div>
          <div className="card-v">{analytics.completionRate}%</div>
          <div className="small">完了/総数 の割合</div>
        </div>
        <div className="card">
          <div className="card-k">今日の予定時間</div>
          <div className="card-v">{analytics.eventMin}分</div>
          <div className="small">イベント合計（概算）</div>
        </div>
        <div className="card">
          <div className="card-k">実績（入力があれば）</div>
          <div className="card-v">{analytics.doneMinutes}分</div>
          <div className="small">doneのactualMin合計</div>
        </div>
      </div>

      <div className="section-title">タグ別件数</div>
      <div className="list dense">
        {allTags.map((t) => (
          <div key={t} className="list-item">
            <div className="li-main">
              <div className="li-title"><Icon name="tag" /> {t}</div>
              <div className="li-sub">{analytics.tagCount[t] || 0} 件</div>
            </div>
          </div>
        ))}
        {!allTags.length ? <div className="empty">タグがありません</div> : null}
      </div>
    </div>
  );
}

function FeaturesPanel() {
  return (
    <div className="panel">
      <div className="panel-head">
        <div className="panel-title"><Icon name="spark" /> 機能一覧（約100）</div>
      </div>

      <div className="small tip">
        このApp.jsは「土台（動く最小の高機能）」として実装しています。ここから本格機能（共有・外部連携・本物のAIなど）を拡張できます。
      </div>

      <div className="feature-grid">
        {FEATURE_CATALOG.map((f, idx) => (
          <div key={idx} className="feature">
            <div className="feature-num">{idx + 1}</div>
            <div className="feature-name">{f}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// -------------------- Modals --------------------
function SettingsModal({ open, onClose, settings, setSettings }) {
  return (
    <Modal
      open={open}
      title="設定"
      onClose={onClose}
      footer={
        <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
          <div className="small">変更は自動保存されます</div>
          <button className="btn primary" onClick={onClose}>閉じる</button>
        </div>
      }
    >
      <div className="form">
        <div className="form-row">
          <label>テーマ</label>
          <select value={settings.theme} onChange={(e) => setSettings((s) => ({ ...s, theme: e.target.value }))}>
            <option value="light">ライト</option>
            <option value="dark">ダーク</option>
          </select>
        </div>

        <div className="form-row">
          <label>表示密度</label>
          <select value={settings.density} onChange={(e) => setSettings((s) => ({ ...s, density: e.target.value }))}>
            <option value="comfortable">標準</option>
            <option value="compact">コンパクト</option>
          </select>
        </div>

        <div className="form-row">
          <label>週の開始</label>
          <select
            value={settings.weekStartsOnMonday ? "mon" : "sun"}
            onChange={(e) => setSettings((s) => ({ ...s, weekStartsOnMonday: e.target.value === "mon" }))}
          >
            <option value="mon">月曜</option>
            <option value="sun">日曜</option>
          </select>
        </div>

        <div className="form-row">
          <label>勤務時間</label>
          <div className="row">
            <input
              type="number"
              min={0}
              max={23}
              value={settings.workingHours.start}
              onChange={(e) =>
                setSettings((s) => ({ ...s, workingHours: { ...s.workingHours, start: parseInt(e.target.value || "9", 10) } }))
              }
            />
            <span className="small">〜</span>
            <input
              type="number"
              min={1}
              max={24}
              value={settings.workingHours.end}
              onChange={(e) =>
                setSettings((s) => ({ ...s, workingHours: { ...s.workingHours, end: parseInt(e.target.value || "18", 10) } }))
              }
            />
          </div>
        </div>

        <div className="form-row">
          <label>スマート提案</label>
          <input
            type="checkbox"
            checked={settings.smartSuggestions}
            onChange={(e) => setSettings((s) => ({ ...s, smartSuggestions: e.target.checked }))}
          />
        </div>

        <div className="form-row">
          <label>自動休憩</label>
          <input
            type="checkbox"
            checked={settings.autoBreaks}
            onChange={(e) => setSettings((s) => ({ ...s, autoBreaks: e.target.checked }))}
          />
        </div>

        <div className="form-row">
          <label>デフォルト予定時間</label>
          <input
            type="number"
            min={15}
            max={480}
            step={15}
            value={settings.defaultEventDurationMin}
            onChange={(e) => setSettings((s) => ({ ...s, defaultEventDurationMin: parseInt(e.target.value || "60", 10) }))}
          />
          <span className="small">分</span>
        </div>

        <div className="form-row">
          <label>デフォルトタスク見積</label>
          <input
            type="number"
            min={5}
            max={480}
            step={5}
            value={settings.defaultTaskEstimateMin}
            onChange={(e) => setSettings((s) => ({ ...s, defaultTaskEstimateMin: parseInt(e.target.value || "30", 10) }))}
          />
          <span className="small">分</span>
        </div>
      </div>
    </Modal>
  );
}

function QuickAddModal({ open, onClose, onSubmit }) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (open) setText("");
  }, [open]);

  return (
    <Modal
      open={open}
      title="クイック追加（自然言語）"
      onClose={onClose}
      footer={
        <div className="row" style={{ justifyContent: "flex-end", gap: 8, width: "100%" }}>
          <button className="btn ghost" onClick={onClose}>キャンセル</button>
          <button className="btn primary" onClick={() => onSubmit(text)}>追加</button>
        </div>
      }
    >
      <div className="form">
        <div className="small tip">
          例: 「明日 10:00-11:00 会議」 / 「2/25 発表準備 90分」
        </div>
        <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="ここに入力…" />
      </div>
    </Modal>
  );
}

function EventModal({ open, event, onClose, onSave, onDelete }) {
  const [draft, setDraft] = useState(event || null);

  useEffect(() => setDraft(event || null), [event]);

  if (!open || !draft) return null;

  return (
    <Modal
      open={open}
      title={draft.id ? "イベント編集" : "イベント作成"}
      onClose={onClose}
      footer={
        <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
          {draft.id ? (
            <button className="btn danger" onClick={() => onDelete(draft.id)}>
              <Icon name="trash" /> 削除
            </button>
          ) : <span />}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>キャンセル</button>
            <button className="btn primary" onClick={() => onSave(draft)}>保存</button>
          </div>
        </div>
      }
    >
      <div className="form">
        <div className="form-row">
          <label>タイトル</label>
          <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
        </div>
        <div className="form-row">
          <label>日付</label>
          <input type="date" value={draft.dateISO} onChange={(e) => setDraft((d) => ({ ...d, dateISO: e.target.value }))} />
        </div>
        <div className="form-row">
          <label>開始</label>
          <input
            type="time"
            value={draft.startMin != null ? humanTime(draft.startMin) : "09:00"}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":").map((x) => parseInt(x, 10));
              const startMin = h * 60 + m;
              const dur = draft.durationMin || 60;
              setDraft((d) => ({ ...d, startMin, endMin: startMin + dur }));
            }}
          />
        </div>
        <div className="form-row">
          <label>長さ</label>
          <input
            type="number"
            min={15}
            max={480}
            step={15}
            value={draft.durationMin || 60}
            onChange={(e) => {
              const durationMin = parseInt(e.target.value || "60", 10);
              setDraft((d) => ({ ...d, durationMin, endMin: (d.startMin ?? 540) + durationMin }));
            }}
          />
          <span className="small">分</span>
        </div>
        <div className="form-row">
          <label>色</label>
          <select value={draft.color || "blue"} onChange={(e) => setDraft((d) => ({ ...d, color: e.target.value }))}>
            <option value="blue">青</option>
            <option value="green">緑</option>
            <option value="red">赤</option>
            <option value="purple">紫</option>
            <option value="orange">橙</option>
          </select>
        </div>
        <div className="form-row">
          <label>タグ</label>
          <input
            value={(draft.tags || []).join(",")}
            onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }))}
            placeholder="例: 研究, 事務"
          />
        </div>
        <div className="form-row">
          <label>メモ</label>
          <textarea rows={4} value={draft.notes || ""} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
        </div>
      </div>
    </Modal>
  );
}

function TaskModal({ open, task, onClose, onSave, onDelete }) {
  const [draft, setDraft] = useState(task || null);
  useEffect(() => setDraft(task || null), [task]);
  if (!open || !draft) return null;

  return (
    <Modal
      open={open}
      title={draft.id ? "タスク編集" : "タスク作成"}
      onClose={onClose}
      footer={
        <div className="row" style={{ justifyContent: "space-between", width: "100%" }}>
          {draft.id ? (
            <button className="btn danger" onClick={() => onDelete(draft.id)}>
              <Icon name="trash" /> 削除
            </button>
          ) : <span />}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn ghost" onClick={onClose}>キャンセル</button>
            <button className="btn primary" onClick={() => onSave(draft)}>保存</button>
          </div>
        </div>
      }
    >
      <div className="form">
        <div className="form-row">
          <label>タイトル</label>
          <input value={draft.title} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
        </div>
        <div className="form-row">
          <label>期限</label>
          <input type="date" value={draft.dueDate || ""} onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))} />
        </div>
        <div className="form-row">
          <label>見積</label>
          <input
            type="number"
            min={5}
            max={960}
            step={5}
            value={draft.estimateMin || 30}
            onChange={(e) => setDraft((d) => ({ ...d, estimateMin: parseInt(e.target.value || "30", 10) }))}
          />
          <span className="small">分</span>
        </div>
        <div className="form-row">
          <label>優先度</label>
          <select value={draft.priority || "normal"} onChange={(e) => setDraft((d) => ({ ...d, priority: e.target.value }))}>
            <option value="low">低</option>
            <option value="normal">中</option>
            <option value="high">高</option>
            <option value="critical">最優先</option>
          </select>
        </div>
        <div className="form-row">
          <label>状態</label>
          <select value={draft.status || "todo"} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}>
            <option value="todo">未着手</option>
            <option value="doing">進行中</option>
            <option value="done">完了</option>
          </select>
        </div>
        <div className="form-row">
          <label>難易度</label>
          <select value={draft.difficulty || "medium"} onChange={(e) => setDraft((d) => ({ ...d, difficulty: e.target.value }))}>
            <option value="easy">簡単</option>
            <option value="medium">普通</option>
            <option value="hard">難しい</option>
          </select>
        </div>
        <div className="form-row">
          <label>タグ</label>
          <input
            value={(draft.tags || []).join(",")}
            onChange={(e) => setDraft((d) => ({ ...d, tags: e.target.value.split(",").map((x) => x.trim()).filter(Boolean) }))}
            placeholder="例: 研究, 事務"
          />
        </div>
        <div className="form-row">
          <label>スター</label>
          <input type="checkbox" checked={!!draft.starred} onChange={(e) => setDraft((d) => ({ ...d, starred: e.target.checked }))} />
        </div>
        <div className="form-row">
          <label>ピン留め</label>
          <input type="checkbox" checked={!!draft.pinned} onChange={(e) => setDraft((d) => ({ ...d, pinned: e.target.checked }))} />
        </div>
        <div className="form-row">
          <label>メモ</label>
          <textarea rows={4} value={draft.notes || ""} onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))} />
        </div>
      </div>
    </Modal>
  );
}

// -------------------- Styles --------------------
function GlobalStyles({ theme, density }) {
  return (
    <style>{`
      :root{
        --bg: ${theme === "dark" ? "#0b0f14" : "#f6f8fb"};
        --panel: ${theme === "dark" ? "#101823" : "#ffffff"};
        --text: ${theme === "dark" ? "#e7edf6" : "#1f2a37"};
        --muted: ${theme === "dark" ? "#9fb0c6" : "#637083"};
        --line: ${theme === "dark" ? "#223044" : "#e6ebf2"};
        --shadow: 0 10px 25px rgba(0,0,0,0.08);
        --radius: 14px;
        --pad: ${density === "compact" ? "8px" : "12px"};
        --pad2: ${density === "compact" ? "10px" : "14px"};
        --chip: ${theme === "dark" ? "rgba(255,255,255,0.06)" : "#f2f5fb"};
        --blue: #1a73e8;
        --green: #188038;
        --red: #d93025;
        --purple: #9334e6;
        --orange: #f29900;
      }

      *{ box-sizing:border-box; }
      body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; background: var(--bg); color: var(--text); }
      .app-root{ min-height:100vh; }
      .ic{ margin-right:6px; }

      .topbar{
        position: sticky; top:0; z-index: 50;
        display:flex; align-items:center; justify-content:space-between;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        background: ${theme === "dark" ? "rgba(16,24,35,0.9)" : "rgba(255,255,255,0.85)"};
        backdrop-filter: blur(8px);
      }
      .topbar .left, .topbar .right{ display:flex; align-items:center; gap:8px; }
      .brand{ font-weight:700; padding: 6px 10px; border-radius: 10px; cursor:pointer; }
      .brand:hover{ background: var(--chip); }
      .title{ font-weight:700; margin-left: 6px; margin-right: 8px; }
      .view-tabs{ display:flex; background: var(--chip); border-radius: 12px; padding: 3px; gap: 3px; }
      .tab{ border:0; background: transparent; padding: 7px 10px; border-radius: 10px; cursor:pointer; color: var(--muted); }
      .tab.active{ background: var(--panel); color: var(--text); box-shadow: 0 1px 0 rgba(0,0,0,0.04); }

      .search{
        display:flex; align-items:center; gap: 8px;
        border:1px solid var(--line);
        background: var(--panel);
        border-radius: 999px;
        padding: 8px 10px;
        min-width: 260px;
      }
      .search input{ border:0; outline:none; width: 220px; background: transparent; color: var(--text); }

      .btn{
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        border-radius: 12px;
        padding: 8px 10px;
        cursor: pointer;
        display:inline-flex; align-items:center; gap:6px;
      }
      .btn:hover{ filter: brightness(${theme === "dark" ? "1.08" : "0.98"}); }
      .btn.primary{ background: var(--blue); color: white; border-color: rgba(0,0,0,0); }
      .btn.danger{ background: var(--red); color: white; border-color: rgba(0,0,0,0); }
      .btn.ghost{ background: transparent; }
      .btn.full{ width:100%; justify-content:center; }

      .body{ display:flex; height: calc(100vh - 58px); }
      .sidebar{
        width: 280px;
        border-right: 1px solid var(--line);
        padding: var(--pad2);
        overflow:auto;
      }
      .main{
        flex:1;
        padding: var(--pad2);
        overflow:auto;
      }
      .rightpanel{
        width: 360px;
        border-left: 1px solid var(--line);
        padding: var(--pad2);
        overflow:auto;
      }

      .userbox{ display:flex; gap:10px; align-items:center; padding: 10px; border:1px solid var(--line); background: var(--panel); border-radius: var(--radius); }
      .avatar{ width: 38px; height:38px; border-radius: 12px; display:flex; align-items:center; justify-content:center; background: var(--chip); font-weight:700; }
      .usertext .name{ font-weight:700; }
      .usertext .mail{ color: var(--muted); font-size: 12px; }

      .side-section{ margin-top: 14px; }
      .side-title{ color: var(--muted); font-size: 12px; margin: 8px 2px; }
      .side-item{
        width:100%;
        border:1px solid var(--line);
        background: var(--panel);
        border-radius: 12px;
        padding: 10px 10px;
        display:flex; align-items:center; gap: 8px;
        cursor:pointer;
        margin-bottom: 8px;
      }
      .side-item.active{ outline: 2px solid rgba(26,115,232,0.25); }
      .grow{ flex:1; }
      .mini-hint{ font-size:12px; color: var(--muted); margin-top: 8px; line-height: 1.4; }

      .filter-row{ display:flex; align-items:center; justify-content:space-between; gap: 10px; margin-bottom: 8px; }
      .filter-row label{ color: var(--muted); font-size: 12px; min-width: 46px; }
      select, input, textarea{
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        border-radius: 12px;
        padding: 10px 10px;
        outline:none;
      }
      textarea{ width:100%; resize: vertical; }
      input[type="number"], input[type="date"], input[type="time"], select{ width: 100%; }

      .panel{ display:flex; flex-direction:column; gap: 10px; }
      .panel-head{ display:flex; align-items:center; justify-content:space-between; }
      .panel-title{ font-weight:700; }
      .panel-actions{ display:flex; gap: 8px; }
      .panel-footer{ margin-top: 10px; border-top: 1px solid var(--line); padding-top: 10px; }

      .small{ font-size: 12px; color: var(--muted); }
      .tip{ border: 1px dashed var(--line); border-radius: 12px; padding: 10px; background: ${theme === "dark" ? "rgba(255,255,255,0.03)" : "#fff"}; }

      .view{ background: var(--panel); border:1px solid var(--line); border-radius: var(--radius); box-shadow: var(--shadow); overflow:hidden; }
      .hint-row{ border-top: 1px solid var(--line); padding: 10px 12px; color: var(--muted); font-size: 12px; }

      /* Month */
      .month-header-row{ display:grid; grid-template-columns: repeat(7, 1fr); border-bottom: 1px solid var(--line); background: ${theme === "dark" ? "rgba(255,255,255,0.03)" : "#f7f9fc"}; }
      .month-header-cell{ padding: 10px; font-weight:700; font-size: 12px; color: var(--muted); }
      .month-grid{ display:grid; grid-template-columns: repeat(7, 1fr); grid-auto-rows: 120px; }
      .month-cell{ border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 8px; cursor:pointer; position:relative; }
      .month-cell:nth-child(7n){ border-right: 0; }
      .month-cell.dim{ background: ${theme === "dark" ? "rgba(0,0,0,0.12)" : "#fafbfe"}; color: var(--muted); }
      .month-cell.selected{ outline: 2px solid rgba(26,115,232,0.3); z-index: 2; }
      .month-cell.today .num{ background: rgba(26,115,232,0.12); border-radius: 10px; padding: 2px 6px; }
      .month-date{ display:flex; justify-content:space-between; align-items:center; }
      .month-date .num{ font-weight:700; }
      .month-items{ margin-top: 6px; display:flex; flex-direction:column; gap: 4px; }
      .chip{
        font-size: 11px;
        border-radius: 10px;
        padding: 4px 6px;
        background: var(--chip);
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
      }
      .chip-task{ background: rgba(24,128,56,0.12); }
      .chip-more{ color: var(--muted); }

      .chip-blue{ background: rgba(26,115,232,0.14); }
      .chip-green{ background: rgba(24,128,56,0.14); }
      .chip-red{ background: rgba(217,48,37,0.14); }
      .chip-purple{ background: rgba(147,52,230,0.14); }
      .chip-orange{ background: rgba(242,153,0,0.14); }

      /* Week */
      .week-head{ display:grid; grid-template-columns: 70px repeat(7, 1fr); border-bottom: 1px solid var(--line); }
      .week-col{ position: relative; }
      .hour-col{ background: ${theme === "dark" ? "rgba(255,255,255,0.03)" : "#f7f9fc"}; }
      .day-head{ padding: 10px; cursor:pointer; border-left: 1px solid var(--line); }
      .day-head.selected{ outline: 2px solid rgba(26,115,232,0.25); }
      .day-head.today{ background: rgba(26,115,232,0.06); }
      .week-dow{ font-weight:700; }
      .week-date{ color: var(--muted); font-size: 12px; }
      .week-mini{ margin-top: 6px; display:flex; flex-direction:column; gap:4px; }
      .mini-task{ font-size: 11px; color: var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }

      .week-grid{ display:grid; grid-template-columns: 70px repeat(7, 1fr); height: 700px; }
      .hour-cell{ height: calc(700px / 24); border-top: 1px solid var(--line); display:flex; align-items:flex-start; padding: 2px 6px; color: var(--muted); font-size: 11px; }
      .day-col{ border-left: 1px solid var(--line); }
      .slot{ height: calc(700px / 24); border-top: 1px solid var(--line); }
      .slot.off{ background: ${theme === "dark" ? "rgba(0,0,0,0.12)" : "#fafbfe"}; }
      .event-block{
        position:absolute; left: 6px; right: 6px;
        border-radius: 12px;
        padding: 8px;
        color: white;
        cursor:pointer;
        overflow:hidden;
        box-shadow: 0 8px 18px rgba(0,0,0,0.12);
      }
      .ev-blue{ background: var(--blue); }
      .ev-green{ background: var(--green); }
      .ev-red{ background: var(--red); }
      .ev-purple{ background: var(--purple); }
      .ev-orange{ background: var(--orange); }
      .event-title{ font-weight:700; font-size: 12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .event-time{ font-size: 11px; opacity: 0.9; }

      /* Day */
      .day-top{ display:flex; align-items:center; justify-content:space-between; padding: 12px; border-bottom: 1px solid var(--line); }
      .day-title{ font-weight: 800; }
      .day-actions{ display:flex; gap: 8px; }
      .day-columns{ display:grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px; }
      .day-col{ min-height: 520px; }
      .section-title{ font-weight: 800; margin: 6px 0; }
      .planbox{ border: 1px solid var(--line); border-radius: 12px; padding: 10px; background: ${theme === "dark" ? "rgba(255,255,255,0.02)" : "#fbfcff"}; }
      .planrow{ display:flex; gap:10px; padding: 6px 6px; border-radius: 10px; }
      .planrow.task:hover{ background: rgba(26,115,232,0.06); }
      .planrow.break{ opacity: 0.8; }
      .pt{ min-width: 92px; color: var(--muted); font-size: 12px; }
      .ptt{ font-size: 13px; }

      /* list */
      .list{ border: 1px solid var(--line); border-radius: 12px; overflow:hidden; background: var(--panel); }
      .list.dense .list-item{ padding: 8px; }
      .list-item{
        display:flex; gap: 8px; align-items:flex-start;
        padding: 10px;
        border-bottom: 1px solid var(--line);
      }
      .list-item:last-child{ border-bottom: 0; }
      .li-main{ flex:1; }
      .li-title{ font-weight: 700; }
      .li-sub{ color: var(--muted); font-size: 12px; margin-top: 2px; }
      .li-sub.pre{ white-space: pre-wrap; }

      .clickable{ cursor:pointer; }
      .dot{ width: 10px; height:10px; border-radius: 999px; margin-top: 6px; background: var(--blue); }
      .dot-blue{ background: var(--blue); }
      .dot-green{ background: var(--green); }
      .dot-red{ background: var(--red); }
      .dot-purple{ background: var(--purple); }
      .dot-orange{ background: var(--orange); }
      .dot-task{ background: var(--green); }
      .dot-blue{ background: var(--blue); }
      .dot-green{ background: var(--green); }
      .dot-red{ background: var(--red); }
      .dot-purple{ background: var(--purple); }
      .dot-orange{ background: var(--orange); }

      .pill{
        border-radius: 999px;
        padding: 4px 8px;
        font-size: 11px;
        border: 1px solid var(--line);
        background: var(--chip);
        color: var(--text);
        white-space: nowrap;
      }
      .pill.blue{ background: rgba(26,115,232,0.12); border-color: rgba(26,115,232,0.25); }
      .pill.green{ background: rgba(24,128,56,0.12); border-color: rgba(24,128,56,0.25); }

      .empty{ padding: 14px; color: var(--muted); font-size: 13px; }

      /* chat */
      .chat{ height: 520px; overflow:auto; border:1px solid var(--line); border-radius: 12px; padding: 10px; background: ${theme === "dark" ? "rgba(255,255,255,0.02)" : "#fbfcff"}; }
      .chat-msg{ display:flex; margin-bottom: 10px; }
      .chat-msg.user{ justify-content:flex-end; }
      .bubble{ max-width: 86%; border-radius: 14px; padding: 10px; background: var(--panel); border:1px solid var(--line); }
      .chat-msg.user .bubble{ background: rgba(26,115,232,0.12); border-color: rgba(26,115,232,0.25); }
      .bubble-text{ margin:0; white-space: pre-wrap; font-family: inherit; font-size: 13px; line-height: 1.45; }

      .chat-input{ display:flex; gap: 8px; align-items:flex-end; }
      .chat-input textarea{ flex:1; }

      /* modal */
      .modal-backdrop{
        position: fixed; inset: 0;
        background: rgba(0,0,0,0.38);
        display:flex; align-items:center; justify-content:center;
        z-index: 100;
        padding: 20px;
      }
      .modal{
        width: min(720px, 96vw);
        border-radius: 16px;
        background: var(--panel);
        border:1px solid var(--line);
        box-shadow: 0 20px 55px rgba(0,0,0,0.25);
        overflow:hidden;
      }
      .modal-header{
        display:flex; align-items:center; justify-content:space-between;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
      }
      .modal-title{ font-weight: 800; }
      .modal-body{ padding: 12px 14px; }
      .modal-footer{ padding: 12px 14px; border-top: 1px solid var(--line); background: ${theme === "dark" ? "rgba(255,255,255,0.02)" : "#fbfcff"}; }

      .form{ display:flex; flex-direction:column; gap: 10px; }
      .form-row{ display:flex; align-items:center; gap: 10px; }
      .form-row label{ min-width: 92px; color: var(--muted); font-size: 12px; }
      .row{ display:flex; align-items:center; gap: 10px; }
      .note-editor{ border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: var(--panel); }
      .cards{ display:grid; grid-template-columns: 1fr; gap: 10px; }
      .card{ border: 1px solid var(--line); border-radius: 12px; padding: 12px; background: var(--panel); }
      .card-k{ color: var(--muted); font-size: 12px; }
      .card-v{ font-size: 28px; font-weight: 900; margin-top: 6px; }

      .feature-grid{ display:grid; grid-template-columns: 1fr; gap: 8px; }
      .feature{ border: 1px solid var(--line); border-radius: 12px; padding: 10px; display:flex; gap: 10px; align-items:center; background: var(--panel); }
      .feature-num{ width: 36px; height: 28px; border-radius: 10px; display:flex; align-items:center; justify-content:center; background: var(--chip); color: var(--muted); font-weight: 800; }
      .feature-name{ font-weight: 700; }

      /* auth */
      .auth-screen{ display:flex; align-items:center; justify-content:center; min-height:100vh; padding: 20px; }
      .auth-card{
        width: min(520px, 96vw);
        border: 1px solid var(--line);
        background: var(--panel);
        border-radius: 18px;
        box-shadow: var(--shadow);
        padding: 22px;
        text-align:center;
      }
      .auth-title{ font-size: 28px; font-weight: 900; }
      .auth-sub{ color: var(--muted); margin: 10px 0 18px; line-height: 1.4; }
      .auth-foot{ color: var(--muted); margin-top: 14px; font-size: 12px; }

      /* print */
      @media print{
        .sidebar, .rightpanel, .topbar{ display:none !important; }
        .main{ padding:0; }
        .view{ box-shadow:none; border:0; }
        body{ background:white; }
      }
    `}</style>
  );
}
