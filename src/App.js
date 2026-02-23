import React, { useEffect, useMemo, useState } from "react";
import apiMod from "./api";
const { api, clearLocalUser, getLocalUser, setLocalUser } = apiMod;
import mdMod from "./markdown";
const { excerpt, renderMarkdown } = mdMod;

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

function slugify(s) {
  return (s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9\-ぁ-んァ-ン一-龥]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || ("page-" + Math.random().toString(36).slice(2, 8));
}

function Icon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.5"/>
      <path d="M9 8h6M9 12h6M9 16h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
  );
}

function TopNav({ me, onLogout }) {
  return (
    <div className="nav">
      <div className="brand" style={{cursor:"pointer"}} onClick={() => navigate("/")}>
        <Icon />
        <div>
          <div>Super Planner Books</div>
          <div className="small">書く → 公開 → コインで購入</div>
        </div>
      </div>
      <div className="row">
        {me ? (
          <>
            <span className="pill">残高: {me.balance} コイン</span>
            <span className="pill">{me.display_name}</span>
            <button onClick={() => navigate("/new")} className="primary">新規作成</button>
            <button onClick={onLogout}>ログアウト</button>
          </>
        ) : (
          <button onClick={() => navigate("/login")} className="primary">ログイン</button>
        )}
      </div>
    </div>
  );
}

function Login({ onLoggedIn }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr("");
    setBusy(true);
    try {
      const display_name = (name || "").trim() || "ユーザー";
      // Create user + initial 1000 coins
      const data = await api("/api/users", { method: "POST", body: { display_name } });
      setLocalUser({ user_id: data.user_id, token: data.token, display_name: data.display_name });
      onLoggedIn();
      navigate("/");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>ログイン（デモ）</h2>
      <p>このサンプルは簡易ログインです。後でGoogleログイン等に置き換えできます。</p>
      <label>表示名</label>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例）まさえ" />
      {err && <div className="notice" style={{borderColor:"rgba(239,68,68,.4)", color:"#fecaca"}}>{err}</div>}
      <div className="row" style={{marginTop:12}}>
        <button className="primary" disabled={busy} onClick={submit}>はじめる（初期1000コイン）</button>
        <span className="small">EnterキーでもOK</span>
      </div>
    </div>
  );
}

function Dashboard({ me, token }) {
  const [mine, setMine] = useState([]);
  const [publics, setPublics] = useState([]);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const d = await api("/api/pages/mine", { token });
      setMine(d.pages || []);
      const p = await api("/api/pages/public");
      setPublics(p.pages || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="grid">
      <div className="col-12">
        <div className="card">
          <h2>ダッシュボード</h2>
          <p>あなたの下書き/公開作品と、全体の公開作品を表示します。</p>
          {err && <div className="notice" style={{borderColor:"rgba(239,68,68,.4)", color:"#fecaca"}}>{err}</div>}
          {busy ? <p>読み込み中…</p> : null}
        </div>
      </div>

      <div className="col-6">
        <div className="card">
          <div className="row" style={{justifyContent:"space-between"}}>
            <h2>あなたの作品</h2>
            <button onClick={() => navigate("/new")} className="primary">新規作成</button>
          </div>
          <div className="hr" />
          {!mine.length ? <p>まだ作品がありません。</p> : null}
          {mine.map(pg => (
            <div key={pg.id} className="card" style={{marginTop:10}}>
              <div className="row" style={{justifyContent:"space-between"}}>
                <div>
                  <div style={{fontWeight:700}}>{pg.title}</div>
                  <div className="small">{pg.status === "published" ? (
                    <span className="badge pub">公開</span>
                  ) : (
                    <span className="badge draft">下書き</span>
                  )}　価格: {pg.price_coins} コイン</div>
                </div>
                <div className="row">
                  <button onClick={() => navigate(`/edit/${pg.id}`)}>編集</button>
                  {pg.status === "published" ? (
                    <button className="good" onClick={() => window.open(`#/p/${pg.slug}`, "_blank")}>閲覧</button>
                  ) : null}
                </div>
              </div>
              <p style={{marginTop:8}}>{excerpt(pg.content, 220)}</p>
              {pg.cover_image_url ? <img className="thumb" src={pg.cover_image_url} alt="" /> : null}
              <div className="small">URL: <span className="kbd">#/p/{pg.slug}</span></div>
            </div>
          ))}
        </div>
      </div>

      <div className="col-6">
        <div className="card">
          <h2>公開作品（みんな）</h2>
          <p className="small">購入が必要な作品は、購入すると全文が読めます。</p>
          <div className="hr" />
          {!publics.length ? <p>公開作品がまだありません。</p> : null}
          {publics.map(pg => (
            <div key={pg.id} className="card" style={{marginTop:10}}>
              <div className="row" style={{justifyContent:"space-between"}}>
                <div>
                  <div style={{fontWeight:700}}>{pg.title}</div>
                  <div className="small">作者: {pg.author_name}　価格: {pg.price_coins} コイン</div>
                </div>
                <div className="row">
                  <button className="good" onClick={() => navigate(`/p/${pg.slug}`)}>読む</button>
                </div>
              </div>
              <p style={{marginTop:8}}>{excerpt(pg.content, 220)}</p>
              {pg.cover_image_url ? <img className="thumb" src={pg.cover_image_url} alt="" /> : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Editor({ me, token, pageId }) {
  const isNew = !pageId;
  const [page, setPage] = useState({ title:"", slug:"", content:"", cover_image_url:"", price_coins: 0, status:"draft" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedMsg, setSavedMsg] = useState("");

  useEffect(() => {
    if (isNew) return;
    (async () => {
      try {
        const d = await api(`/api/pages/${pageId}`, { token });
        setPage(d.page);
      } catch (e) {
        setErr(e.message);
      }
    })();
  }, [pageId]);

  const previewHtml = useMemo(() => renderMarkdown(page.content), [page.content]);

  async function save() {
    setErr("");
    setSavedMsg("");
    setBusy(true);
    try {
      if (isNew) {
        const slug = page.slug?.trim() ? page.slug.trim() : slugify(page.title);
        const d = await api("/api/pages", { method:"POST", token, body: { ...page, slug } });
        setSavedMsg("保存しました。");
        navigate(`/edit/${d.page.id}`);
      } else {
        const d = await api(`/api/pages/${pageId}`, { method:"PUT", token, body: page });
        setSavedMsg("保存しました。");
        setPage(d.page);
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
      setTimeout(() => setSavedMsg(""), 2500);
    }
  }

  async function publish() {
    setErr("");
    setSavedMsg("");
    setBusy(true);
    try {
      const d = await api(`/api/pages/${pageId}/publish`, { method:"POST", token });
      setPage(d.page);
      setSavedMsg("公開しました。");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
      setTimeout(() => setSavedMsg(""), 2500);
    }
  }

  async function uploadImage(file, asCover=false) {
    if (!file) return;
    setErr("");
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("as_cover", asCover ? "1" : "0");
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: token ? { "Authorization": `Bearer ${token}` } : undefined,
        body: form
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      const url = data.url;
      if (asCover) {
        setPage(p => ({ ...p, cover_image_url: url }));
      } else {
        // Insert markdown image at end (simple). You can make this "insert at cursor" later.
        setPage(p => ({ ...p, content: (p.content || "") + `\n\n![](${url})\n` }));
      }
      setSavedMsg("画像を追加しました。");
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
      setTimeout(() => setSavedMsg(""), 2500);
    }
  }

  return (
    <div className="grid">
      <div className="col-12">
        <div className="card">
          <div className="row" style={{justifyContent:"space-between"}}>
            <div>
              <h2>{isNew ? "新規作成" : "編集"}</h2>
              <p className="small">保存: <span className="kbd">Ctrl</span> + <span className="kbd">S</span></p>
            </div>
            <div className="row">
              <button onClick={() => navigate("/")} >戻る</button>
              <button className="primary" disabled={busy} onClick={save}>保存</button>
              {!isNew ? (
                <button className="good" disabled={busy || page.status === "published"} onClick={publish}>
                  {page.status === "published" ? "公開済み" : "公開"}
                </button>
              ) : null}
            </div>
          </div>
          {err && <div className="notice" style={{borderColor:"rgba(239,68,68,.4)", color:"#fecaca"}}>{err}</div>}
          {savedMsg && <div className="notice" style={{borderColor:"rgba(34,197,94,.4)", color:"#bbf7d0"}}>{savedMsg}</div>}
          <div className="grid" style={{marginTop:8}}>
            <div className="col-6">
              <label>タイトル</label>
              <input value={page.title} onChange={(e) => setPage(p => ({...p, title:e.target.value}))} />
            </div>
            <div className="col-6">
              <label>スラッグ（URLの末尾）</label>
              <input value={page.slug} onChange={(e) => setPage(p => ({...p, slug:e.target.value}))} placeholder="空ならタイトルから自動生成" />
              <div className="small">公開URL: <span className="kbd">#/p/{page.slug || slugify(page.title)}</span></div>
            </div>
            <div className="col-6">
              <label>価格（コイン）</label>
              <input type="number" min="0" value={page.price_coins} onChange={(e) => setPage(p => ({...p, price_coins: Number(e.target.value || 0)}))} />
              <div className="small">0なら無料</div>
            </div>
            <div className="col-6">
              <label>表紙画像</label>
              <div className="row">
                <input type="file" accept="image/*" onChange={(e) => uploadImage(e.target.files?.[0], true)} />
              </div>
              {page.cover_image_url ? <img className="thumb" src={page.cover_image_url} alt="" style={{marginTop:8}}/> : <div className="small">未設定</div>}
            </div>
            <div className="col-6">
              <label>本文（Markdown）</label>
              <textarea value={page.content} onChange={(e) => setPage(p => ({...p, content:e.target.value}))} />
              <div className="row">
                <input type="file" accept="image/*" onChange={(e) => uploadImage(e.target.files?.[0], false)} />
                <span className="small">画像は本文末尾に挿入されます（後で改善可）</span>
              </div>
            </div>
            <div className="col-6">
              <label>プレビュー</label>
              <div className="card markdown" dangerouslySetInnerHTML={{ __html: previewHtml }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PublicPage({ me, token, slug }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(true);
  const [buyBusy, setBuyBusy] = useState(false);

  async function load() {
    setBusy(true);
    setErr("");
    try {
      const d = await api(`/api/p/${encodeURIComponent(slug)}`, { token });
      setData(d);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => { load(); }, [slug]);

  async function purchase() {
    if (!token) { navigate("/login"); return; }
    setBuyBusy(true);
    setErr("");
    try {
      await api("/api/purchase", { method:"POST", token, body: { page_id: data.page.id } });
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBuyBusy(false);
    }
  }

  if (busy) return <div className="card"><p>読み込み中…</p></div>;
  if (err) return <div className="card"><div className="notice" style={{borderColor:"rgba(239,68,68,.4)", color:"#fecaca"}}>{err}</div></div>;
  if (!data) return null;

  const { page, viewer } = data;
  const isOwner = viewer?.user_id && viewer.user_id === page.author_id;
  const canReadFull = page.price_coins === 0 || viewer?.purchased || isOwner;
  const bodyMd = canReadFull ? page.content : excerpt(page.content, 700) + "\n\n---\n\n全文を読むには購入が必要です。";

  return (
    <div className="card">
      <div className="row" style={{justifyContent:"space-between"}}>
        <div>
          <h1>{page.title}</h1>
          <div className="row">
            <span className="pill">作者: {page.author_name}</span>
            <span className="pill">価格: {page.price_coins} コイン</span>
            {page.price_coins > 0 ? (
              <span className="pill">{viewer?.purchased ? "購入済み" : "未購入"}</span>
            ) : <span className="pill">無料</span>}
          </div>
        </div>
        <div className="row">
          <button onClick={() => navigate("/")}>一覧へ</button>
          {isOwner ? <button onClick={() => navigate(`/edit/${page.id}`)}>編集</button> : null}
        </div>
      </div>

      {page.cover_image_url ? <img className="thumb" src={page.cover_image_url} alt="" style={{marginTop:12}}/> : null}

      {page.price_coins > 0 && !canReadFull ? (
        <div className="notice" style={{marginTop:12}}>
          <div style={{display:"flex", justifyContent:"space-between", gap:12, alignItems:"center", flexWrap:"wrap"}}>
            <div>
              <div style={{fontWeight:700}}>購入して全文を読む</div>
              <div className="small">残高: {viewer?.balance ?? "—"} コイン</div>
            </div>
            <button className="good" disabled={buyBusy} onClick={purchase}>
              {buyBusy ? "購入中…" : `${page.price_coins} コインで購入`}
            </button>
          </div>
        </div>
      ) : null}

      <div className="hr" />
      <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyMd) }} />
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const [me, setMe] = useState(null);
  const [err, setErr] = useState("");

  async function refreshMe() {
    const u = getLocalUser();
    if (!u?.token) { setMe(null); return; }
    try {
      const d = await api("/api/me", { token: u.token });
      setMe(d.me);
    } catch (e) {
      // token invalid etc
      setMe(null);
      setErr(e.message);
    }
  }

  useEffect(() => { refreshMe(); }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        // Let Editor handle via buttons; this is just preventing browser save dialog.
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    content = me ? <Editor me={me} token={token} /> : <Login onLoggedIn={refreshMe} />;
  } else if (route.startsWith("/edit/")) {
    const id = route.split("/")[2];
    content = me ? <Editor me={me} token={token} pageId={id} /> : <Login onLoggedIn={refreshMe} />;
  } else if (route.startsWith("/p/")) {
    const slug = route.split("/")[2] || "";
    content = <PublicPage me={me} token={token} slug={slug} />;
  } else {
    content = me ? <Dashboard me={me} token={token} /> : <Login onLoggedIn={refreshMe} />;
  }

  return (
    <div className="container">
      <TopNav me={me} onLogout={logout} />
      <div style={{height:14}} />
      {err ? <div className="notice" style={{borderColor:"rgba(239,68,68,.4)", color:"#fecaca"}}>{err}</div> : null}
      {content}
      <div style={{height:30}} />
      <div className="small">
        <div className="hr" />
        <div>デモ仕様: ログインは簡易（ローカル保存）。コインはアプリ内のみで、実際のお金は扱いません。</div>
      </div>
    </div>
  );
}
