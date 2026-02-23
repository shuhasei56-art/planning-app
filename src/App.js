import React, { useEffect, useState } from "react";
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

function navigate(path) {
  window.location.hash = "#" + path;
}

// === ナビゲーション（上部に配置・ホバーで表示） ===
function TopNav({ me, onLogout, fontSize, setFontSize }) {
  return (
    <div className="minimal-nav">
      <div style={{ cursor: "pointer", fontWeight: "bold" }} onClick={() => navigate("/")}>
        📓 白紙ノート
      </div>
      <div className="nav-actions">
        <span>あAa</span>
        <button onClick={() => setFontSize(Math.max(12, fontSize - 2))}>-</button>
        <button onClick={() => setFontSize(Math.min(32, fontSize + 2))}>+</button>
        <span style={{ margin: "0 10px", color: "#ddd" }}>|</span>
        {me ? (
          <>
            <span className="small">{me.display_name}</span>
            <button onClick={() => navigate("/new")} className="primary">＋ 新しいページ</button>
            <button onClick={onLogout}>ログアウト</button>
          </>
        ) : (
          <button onClick={() => navigate("/login")} className="primary">ログイン</button>
        )}
      </div>
    </div>
  );
}

// === 全画面エディタ ===
function Editor({ token, pageId }) {
  const isNew = !pageId;
  const [page, setPage] = useState({ title: "", slug: "", content: "", status: "draft" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (isNew) {
      setPage({ title: "", slug: "", content: "", status: "draft" });
      return;
    }
    (async () => {
      try {
        const d = await api(`/api/pages/${pageId}`, { token });
        setPage(d.page);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [isNew, pageId, token]);

  // 入力のたびに自動保存のような感覚で保存できるようにしても良いですが、今回は手動保存ボタンを右下に置きます
  async function save() {
    setBusy(true);
    try {
      if (isNew) {
        const slug = "page-" + Math.random().toString(36).slice(2, 8);
        const d = await api("/api/pages", { method: "POST", token, body: { ...page, slug } });
        navigate(`/edit/${d.page.id}`);
      } else {
        await api(`/api/pages/${pageId}`, { method: "PUT", token, body: page });
      }
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  // 次のページへ進む（保存して新規作成画面へ）
  async function saveAndNext() {
    await save();
    navigate("/new");
  }

  return (
    <div className="editor-container">
      <input 
        className="fullscreen-title" 
        placeholder="タイトル..." 
        value={page.title} 
        onChange={(e) => setPage(p => ({...p, title: e.target.value}))} 
      />
      <textarea 
        className="fullscreen-textarea" 
        placeholder="ここに文章を書いてください..." 
        value={page.content} 
        onChange={(e) => setPage(p => ({...p, content: e.target.value}))} 
      />
      <div className="bottom-nav">
        <button disabled={busy} onClick={save} style={{ marginRight: 8 }}>保存する</button>
        <button className="primary" disabled={busy} onClick={saveAndNext}>保存して次のページへ ➔</button>
      </div>
    </div>
  );
}

// === 閲覧画面 ===
function PublicPage({ token, slug }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const d = await api(`/api/p/${encodeURIComponent(slug)}`, { token });
        setData(d);
      } catch (e) {
        console.error(e);
      }
    })();
  }, [slug, token]);

  if (!data) return <div style={{ padding: 80, textAlign: "center" }}>読み込み中...</div>;

  return (
    <div className="reader-container">
      <h1 style={{ fontSize: "1.5em", marginBottom: "0.2em" }}>{data.page.title}</h1>
      <div className="small" style={{ marginBottom: "2em" }}>作者: {data.page.author_name}</div>
      <div dangerouslySetInnerHTML={{ __html: renderMarkdown(data.page.content) }} />
    </div>
  );
}

// === ログイン画面（簡易版） ===
function Login({ onLoggedIn }) {
  const [name, setName] = useState("");
  async function submit() {
    try {
      const display_name = name || "名無し";
      const data = await api("/api/users", { method: "POST", body: { display_name } });
      setLocalUser({ user_id: data.user_id, token: data.token, display_name: data.display_name });
      await onLoggedIn();
      navigate("/");
    } catch (e) {
      alert(e.message);
    }
  }
  return (
    <div style={{ maxWidth: 400, margin: "100px auto", textAlign: "center" }}>
      <h2>ユーザー登録して始める</h2>
      <input value={name} onChange={e => setName(e.target.value)} placeholder="あなたの名前" style={{ padding: 8, fontSize: 16, width: "100%", boxSizing: "border-box", marginBottom: 12 }} />
      <button className="primary" onClick={submit} style={{ width: "100%", padding: 12 }}>開始</button>
    </div>
  );
}

// === ダッシュボード（簡易版） ===
function Dashboard({ token }) {
  const [mine, setMine] = useState([]);
  
  useEffect(() => {
    api("/api/pages/mine", { token }).then(d => setMine(d.pages || []));
  }, [token]);

  return (
    <div className="reader-container">
      <h2>あなたの書いたページ一覧</h2>
      {mine.length === 0 && <p>まだ何も書かれていません。</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {mine.map(pg => (
          <li key={pg.id} style={{ padding: "12px 0", borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between" }}>
            <span style={{ cursor: "pointer", fontSize: "1.2em" }} onClick={() => navigate(`/edit/${pg.id}`)}>
              {pg.title || "無題のページ"}
            </span>
            <span className="small">{new Date(pg.updated_at).toLocaleDateString()}</span>
          </li>
        ))}
      </ul>
      <div style={{ marginTop: 20 }}>
        <button className="primary" onClick={() => navigate("/new")}>＋ 新しいページを書く</button>
      </div>
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const [me, setMe] = useState(null);
  const [fontSize, setFontSize] = useState(18); // デフォルトのフォントサイズ

  // フォントサイズをCSS変数に反映
  useEffect(() => {
    document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
  }, [fontSize]);

  async function refreshMe() {
    const u = getLocalUser();
    if (!u?.token) { setMe(null); return; }
    try {
      const d = await api("/api/me", { token: u.token });
      setMe(d.me);
    } catch {
      setMe(null);
    }
  }

  useEffect(() => { refreshMe(); }, []);

  const u = getLocalUser();
  const token = u?.token;

  function logout() {
    clearLocalUser();
    setMe(null);
    navigate("/login");
  }

  let content = null;
  if (route === "/login") {
    content = <Login onLoggedIn={refreshMe} />;
  } else if (route === "/new") {
    content = token ? <Editor token={token} /> : <Login onLoggedIn={refreshMe} />;
  } else if (route.startsWith("/edit/")) {
    const id = route.split("/")[2];
    content = token ? <Editor token={token} pageId={id} /> : <Login onLoggedIn={refreshMe} />;
  } else if (route.startsWith("/p/")) {
    const slug = route.split("/")[2] || "";
    content = <PublicPage token={token} slug={slug} />;
  } else {
    content = token ? <Dashboard token={token} /> : <Login onLoggedIn={refreshMe} />;
  }

  return (
    <div>
      <TopNav me={me} onLogout={logout} fontSize={fontSize} setFontSize={setFontSize} />
      {content}
    </div>
  );
}
