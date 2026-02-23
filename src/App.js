import React, { useEffect, useState, useRef } from "react";
import apiMod from "./api";
import mdMod from "./markdown";

const { api, clearLocalUser, getLocalUser, setLocalUser } = apiMod;
const { renderMarkdown } = mdMod;

function useHashRoute() {
  const [hash, setHash] = useState(window.location.hash || "#/");
  useEffect(() => {
    const on = () => setHash(window.location.hash || "#/");
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "") || "/";
}

function navigate(path) { window.location.hash = "#" + path; }

// ナビゲーション（ダークモード＆Zenモード切替追加）
function TopNav({ me, onLogout, fontSize, setFontSize, darkMode, setDarkMode, zenMode, setZenMode }) {
  return (
    <div className="minimal-nav">
      <div style={{ cursor: "pointer", fontWeight: "bold" }} onClick={() => navigate("/")}>
        📓 白紙ノート
      </div>
      <div className="nav-actions">
        <button onClick={() => setZenMode(!zenMode)} title="集中モード">
          {zenMode ? "🧘 集中解除" : "🧘 集中"}
        </button>
        <button onClick={() => setDarkMode(!darkMode)} title="ダークモード">
          {darkMode ? "☀️" : "🌙"}
        </button>
        <span style={{ margin: "0 5px", color: "var(--muted-color)" }}>|</span>
        <button onClick={() => setFontSize(Math.max(12, fontSize - 2))}>-</button>
        <button onClick={() => setFontSize(Math.min(32, fontSize + 2))}>+</button>
        <span style={{ margin: "0 5px", color: "var(--muted-color)" }}>|</span>
        {me ? (
          <>
            <button onClick={() => navigate("/new")} className="primary">＋ 新規</button>
            <button onClick={onLogout}>ログアウト</button>
          </>
        ) : (
          <button onClick={() => navigate("/login")} className="primary">ログイン</button>
        )}
      </div>
    </div>
  );
}

function Editor({ token, pageId }) {
  const isNew = !pageId;
  const [page, setPage] = useState({ title: "", slug: "", content: "", status: "draft" });
  const [busy, setBusy] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  
  const GOAL_CHARS = 1000; // 目標文字数
  const wordCount = (page.content || "").replace(/\s+/g, '').length;
  const progressPercent = Math.min(100, (wordCount / GOAL_CHARS) * 100);
  const readingTime = Math.max(1, Math.ceil(wordCount / 500)); // 1分間に500文字読むと仮定

  // ローカルバックアップの復元とデータ取得
  useEffect(() => {
    if (isNew) {
      const draft = localStorage.getItem("sp_draft_new");
      if (draft) setPage(JSON.parse(draft));
      else setPage({ title: "", slug: "", content: "", status: "draft" });
      return;
    }
    (async () => {
      try {
        const d = await api(`/api/pages/${pageId}`, { token });
        const localDraft = localStorage.getItem(`sp_draft_${pageId}`);
        // ローカルのバックアップの方が長ければ復元を促す（今回はシンプルに自動復元）
        if (localDraft && JSON.parse(localDraft).content.length > d.page.content.length) {
          setPage(JSON.parse(localDraft));
          setSaveMsg("バックアップから復元しました");
        } else {
          setPage(d.page);
        }
      } catch (e) { console.error(e); }
    })();
  }, [isNew, pageId, token]);

  // 入力のたびにローカルストレージへ秒速バックアップ（ブラウザクラッシュ対策）
  useEffect(() => {
    if (!page.title && !page.content) return;
    const key = isNew ? "sp_draft_new" : `sp_draft_${pageId}`;
    localStorage.setItem(key, JSON.stringify(page));

    // サーバーへの自動保存（2秒入力が止まったら）
    const timer = setTimeout(() => { save(true); }, 2000);
    return () => clearTimeout(timer);
  }, [page.content, page.title]);

  async function save(isAuto = false) {
    if (!isAuto) setBusy(true);
    try {
      if (isNew) {
        if (!page.title && !page.content) return;
        const slug = "page-" + Math.random().toString(36).slice(2, 8);
        const d = await api("/api/pages", { method: "POST", token, body: { ...page, slug } });
        localStorage.removeItem("sp_draft_new"); // 保存できたらローカル下書き削除
        navigate(`/edit/${d.page.id}`);
      } else {
        await api(`/api/pages/${pageId}`, { method: "PUT", token, body: page });
        setSaveMsg("保存しました");
        setTimeout(() => setSaveMsg(""), 2000);
      }
    } catch (e) {
      if(!isAuto) alert(e.message);
    } finally {
      if (!isAuto) setBusy(false);
    }
  }

  async function askAI() {
    if (!page.content) return alert("少し文章を書いてからAIを呼んでみてください。");
    setAiLoading(true);
    try {
      const prompt = page.content.slice(-300);
      const res = await api("/api/ai", { method: "POST", token, body: { prompt } });
      if (res.result) {
        setPage(p => ({ ...p, content: p.content + "\n" + res.result + "\n" }));
      }
    } catch (e) { alert(e.message); } 
    finally { setAiLoading(false); }
  }

  return (
    <div className="editor-container">
      {/* 画面上部のプログレスバー */}
      <div className="progress-container">
        <div className="progress-bar" style={{ width: `${progressPercent}%` }}></div>
      </div>

      <input 
        className="fullscreen-title" 
        placeholder="タイトル..." 
        value={page.title} 
        onChange={(e) => setPage(p => ({...p, title: e.target.value}))} 
      />
      <textarea 
        className="fullscreen-textarea" 
        placeholder="自由に書き始めてください..." 
        value={page.content} 
        onChange={(e) => setPage(p => ({...p, content: e.target.value}))} 
      />
      
      <div className="bottom-nav">
        <span className="word-count">読む時間の目安: 約 {readingTime} 分</span>
        <span className="word-count">|</span>
        <span className="word-count">{wordCount} / {GOAL_CHARS} 文字</span>
        <span className="word-count" style={{color: "#10b981", width: "80px", marginLeft: "10px"}}>{saveMsg}</span>
        
        <button className="ai-btn" onClick={askAI} disabled={aiLoading}>
          {aiLoading ? "AI執筆中..." : "✨ AIに続きを任せる"}
        </button>
        <button onClick={() => window.print()}>📄 PDF</button>
        <button className="primary" onClick={() => navigate("/new")}>次のページ ➔</button>
      </div>
    </div>
  );
}

// ... Login, Dashboard, PublicPage は以前と同じなので省略（そのまま残してください）...
function Login({ onLoggedIn }) {
  const [name, setName] = useState("");
  async function submit() {
    try {
      const data = await api("/api/users", { method: "POST", body: { display_name: name || "名無し" } });
      setLocalUser({ user_id: data.user_id, token: data.token, display_name: data.display_name });
      await onLoggedIn();
      navigate("/");
    } catch (e) { alert(e.message); }
  }
  return (
    <div style={{ maxWidth: 400, margin: "100px auto", textAlign: "center" }}>
      <h2>ユーザー登録して始める</h2>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="あなたの名前" style={{ padding: 8, fontSize: 16, width: "100%", marginBottom: 12 }} />
      <button className="primary" onClick={submit} style={{ width: "100%", padding: 12 }}>開始</button>
    </div>
  );
}

function Dashboard({ token }) {
  const [mine, setMine] = useState([]);
  useEffect(() => { api("/api/pages/mine", { token }).then(d => setMine(d.pages || [])); }, [token]);
  return (
    <div style={{ maxWidth: 800, margin: "80px auto", padding: "0 20px" }}>
      <h2>あなたの書いたページ一覧</h2>
      {mine.length === 0 && <p>まだ何も書かれていません。</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {mine.map(pg => (
          <li key={pg.id} style={{ padding: "12px 0", borderBottom: "1px solid var(--muted-color)", display: "flex", justifyContent: "space-between" }}>
            <span style={{ cursor: "pointer", fontSize: "1.2em" }} onClick={() => navigate(`/edit/${pg.id}`)}>{pg.title || "無題のページ"}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function PublicPage({ token, slug }) {
  const [data, setData] = useState(null);
  useEffect(() => { api(`/api/p/${encodeURIComponent(slug)}`, { token }).then(setData).catch(console.error); }, [slug, token]);
  if (!data) return <div style={{ padding: 80, textAlign: "center" }}>読み込み中...</div>;
  return (
    <div className="reader-container" style={{ maxWidth: 800, margin: "0 auto", padding: "80px 20px" }}>
      <h1 style={{ fontSize: "1.5em", marginBottom: "0.2em" }}>{data.page.title}</h1>
      <div style={{ marginBottom: "2em", color: "var(--muted-color)", fontSize: "0.8em" }}>作者: {data.page.author_name}</div>
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(data.page.content) }} />
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const [me, setMe] = useState(null);
  const [fontSize, setFontSize] = useState(16);
  const [darkMode, setDarkMode] = useState(false);
  const [zenMode, setZenMode] = useState(false);

  useEffect(() => { document.documentElement.style.setProperty('--font-size', `${fontSize}px`); }, [fontSize]);
  
  // ダークモード・Zenモードのクラス付け替え
  useEffect(() => {
    document.body.classList.toggle('dark-mode', darkMode);
    document.body.classList.toggle('zen-mode', zenMode);
  }, [darkMode, zenMode]);

  async function refreshMe() {
    const u = getLocalUser();
    if (!u?.token) { setMe(null); return; }
    try { const d = await api("/api/me", { token: u.token }); setMe(d.me); } 
    catch { setMe(null); }
  }
  useEffect(() => { refreshMe(); }, []);

  const token = getLocalUser()?.token;
  function logout() { clearLocalUser(); setMe(null); navigate("/login"); }

  let content = null;
  if (route === "/login") content = <Login onLoggedIn={refreshMe} />;
  else if (route === "/new") content = token ? <Editor token={token} /> : <Login onLoggedIn={refreshMe} />;
  else if (route.startsWith("/edit/")) content = token ? <Editor token={token} pageId={route.split("/")[2]} /> : <Login onLoggedIn={refreshMe} />;
  else if (route.startsWith("/p/")) content = <PublicPage token={token} slug={route.split("/")[2] || ""} />;
  else content = token ? <Dashboard token={token} /> : <Login onLoggedIn={refreshMe} />;

  return (
    <div>
      <TopNav me={me} onLogout={logout} fontSize={fontSize} setFontSize={setFontSize} darkMode={darkMode} setDarkMode={setDarkMode} zenMode={zenMode} setZenMode={setZenMode} />
      {content}
    </div>
  );
}
