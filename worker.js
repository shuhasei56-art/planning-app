// Cloudflare Worker for Super Planner Books
// Bindings: env.DB (D1), env.AI (AI)

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS, ...(init.headers || {}) },
  });
}
function err(message, status = 400) {
  return json({ error: message }, { status });
}
function now() {
  return Math.floor(Date.now());
}
function rid(prefix = "") {
  return prefix + crypto.randomUUID();
}

function getToken(req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

async function requireUser(req, env) {
  const token = getToken(req);
  if (!token) return { ok: false, res: err("ログインが必要です", 401) };
  const u = await env.DB.prepare("SELECT id, display_name FROM users WHERE id=?").bind(token).first();
  if (!u) return { ok: false, res: err("無効なトークンです", 401) };
  const w = await env.DB.prepare("SELECT balance FROM wallets WHERE user_id=?").bind(token).first();
  return { ok: true, user: { user_id: u.id, display_name: u.display_name, balance: w?.balance ?? 0 } };
}

async function ensureUser(env, display_name) {
  const user_id = "u_" + crypto.randomUUID();
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?,?,?)").bind(user_id, display_name, t),
    env.DB.prepare("INSERT INTO wallets (user_id, balance, updated_at) VALUES (?,?,?)").bind(user_id, 1000, t),
    env.DB.prepare(
      "INSERT INTO coin_transactions (id, type, from_user_id, to_user_id, amount, page_id, created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(rid("t_"), "initial_grant", null, user_id, 1000, null, t),
  ]);
  return { user_id, display_name, token: user_id, balance: 1000 };
}

function abToBase64(ab) {
  let binary = "";
  const bytes = new Uint8Array(ab);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function handleUpload(req, env) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) return err("multipart/form-data が必要です", 400);

  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return err("file が見つかりません", 400);

  const mime = file.type || "";
  if (!mime.startsWith("image/")) return err("画像ファイルのみ対応です", 400);

  const MAX_BYTES = 1 * 1024 * 1024;
  if (file.size > MAX_BYTES) return err("画像が大きすぎます（最大1MB）。小さくして再アップロードしてください。", 400);

  const ab = await file.arrayBuffer();
  const b64 = abToBase64(ab);

  const id = rid("img_");
  const t = now();

  await env.DB.prepare(
    "INSERT INTO images (id, owner_id, mime, data_base64, bytes, created_at) VALUES (?,?,?,?,?,?)"
  ).bind(id, auth.user.user_id, mime, b64, file.size, t).run();

  const url = new URL(req.url);
  return json({ url: `${url.origin}/api/img/${encodeURIComponent(id)}` });
}

async function handleImage(req, env, id) {
  const row = await env.DB.prepare("SELECT mime, data_base64 FROM images WHERE id=?").bind(id).first();
  if (!row) return new Response("Not found", { status: 404 });

  const bytes = base64ToBytes(row.data_base64);
  return new Response(bytes, {
    headers: {
      "Content-Type": row.mime || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS_HEADERS });

    if (!url.pathname.startsWith("/api/")) {
      return new Response("OK", { status: 200 });
    }

    // === AIアシスト機能 ===
    if (url.pathname === "/api/ai" && req.method === "POST") {
      const auth = await requireUser(req, env);
      if (!auth.ok) return auth.res;

      const body = await req.json().catch(() => null);
      if (!body || !body.prompt) return err("プロンプトが必要です", 400);

      try {
        const response = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: "system", content: "あなたは優秀な執筆アシスタントです。ユーザーが書いた文章の続きを、自然な日本語で1〜2段落ほど作成してください。マークダウンは使わず、プレーンテキストで出力してください。" },
            { role: "user", content: body.prompt }
          ]
        });
        return json({ result: response.response });
      } catch (e) {
        return err("AIの呼び出しに失敗しました。", 500);
      }
    }

    if (url.pathname.startsWith("/api/img/") && req.method === "GET") {
      const id = decodeURIComponent(url.pathname.replace("/api/img/", ""));
      return handleImage(req, env, id);
    }

    if (url.pathname === "/api/users" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const name = (body?.display_name || "ユーザー").toString().slice(0, 40);
      const u = await ensureUser(env, name);
      return json({ user_id: u.user_id, display_name: u.display_name, token: u.token, balance: u.balance });
    }

    if (url.pathname === "/api/me" && req.method === "GET") {
      const auth = await requireUser(req, env);
      if (!auth.ok) return auth.res;
      return json({ me: auth.user });
    }

    if (url.pathname === "/api/upload" && req.method === "POST") {
      return handleUpload(req, env);
    }

    if (url.pathname === "/api/pages" && req.method === "POST") {
      const auth = await requireUser(req, env);
      if (!auth.ok) return auth.res;

      const body = await req.json().catch(() => null);
      if (!body) return err("JSON body が必要です", 400);

      const id = rid("p_");
      const t = now();
      const title = (body.title || "").trim() || "無題";
      const slug = (body.slug || "").trim();
      const content = body.content || "";
      const cover = body.cover_image_url || null;
      const price = Math.max(0, Number(body.price_coins || 0) | 0);

      if (!slug) return err("slug が必要です", 400);

      try {
        await env.DB.prepare(
          "INSERT INTO pages (id, author_id, title, slug, content, cover_image_url, price_coins, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
        ).bind(id, auth.user.user_id, title, slug, content, cover, price, "draft", t, t).run();
      } catch (e) {
        if (String(e).includes("UNIQUE")) return err("そのスラッグは既に使われています", 409);
        return err("作成に失敗しました", 500);
      }

      const page = await env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(id).first();
      return json({ page });
    }

    if (url.pathname === "/api/pages/mine" && req.method === "GET") {
      const auth = await requireUser(req, env);
      if (!auth.ok) return auth.res;
      const rows = await env.DB.prepare("SELECT * FROM pages WHERE author_id=? ORDER BY updated_at DESC").bind(auth.user.user_id).all();
      return json({ pages: rows.results || [] });
    }

    if (url.pathname === "/api/pages/public" && req.method === "GET") {
      const rows = await env.DB.prepare(
        "SELECT p.*, u.display_name AS author_name FROM pages p JOIN users u ON u.id=p.author_id WHERE p.status='published' ORDER BY p.published_at DESC, p.updated_at DESC LIMIT 50"
      ).all();
      return json({ pages: rows.results || [] });
    }

    const mPage = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
    if (mPage && req.method === "GET") {
      const auth = await requireUser(req, env);
      if (!auth.ok) return auth.res;

      const page = await env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(mPage[1]).first();
      if (!page) return err("ページが見つかりません", 404);
      if (page.author_id !== auth.user.user_id) return err("権限がありません", 403);
      return json({ page });
    }

    if (mPage && req.method === "PUT") {
      const auth = await requireUser(req, env);
      if (!auth.ok) return auth.res;

      const page = await env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(mPage[1]).first();
      if (!page) return err("ページが見つかりません", 404);
      if (page.author_id !== auth.user.user_id) return err("権限がありません", 403);

      const body = await req.json().catch(() => null);
      if (!body) return err("JSON body が必要です", 400);

      const t = now();
      const title = (body.title || "").trim() || "無題";
      const slug = (body.slug || "").trim() || page.slug;
      const content = body.content || "";
      const cover = body.cover_image_url || null;
      const price = Math.max(0, Number(body.price_coins || 0) | 0);

      try {
        await env.DB.prepare(
          "UPDATE pages SET title=?, slug=?, content=?, cover_image_url=?, price_coins=?, updated_at=? WHERE id=?"
        ).bind(title, slug, content, cover, price, t, mPage[1]).run();
      } catch (e) {
        if (String(e).includes("UNIQUE")) return err("そのスラッグは既に使われています", 409);
        return err("更新に失敗しました", 500);
      }

      const updated = await env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(mPage[1]).first();
      return json({ page: updated });
    }

    const mPub = url.pathname.match(/^\/api\/pages\/([^/]+)\/publish$/);
    if (mPub && req.method === "POST") {
      const auth = await requireUser(req, env);
      if (!auth.ok) return auth.res;

      const page = await env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(mPub[1]).first();
      if (!page) return err("ページが見つかりません", 404);
      if (page.author_id !== auth.user.user_id) return err("権限がありません", 403);

      const t = now();
      await env.DB.prepare("UPDATE pages SET status='published', published_at=?, updated_at=? WHERE id=?").bind(t, t, mPub[1]).run();
      const updated = await env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(mPub[1]).first();
      return json({ page: updated });
    }

    const mPublic = url.pathname.match(/^\/api\/p\/([^/]+)$/);
    if (mPublic && req.method === "GET") {
      const slug = decodeURIComponent(mPublic[1]);
      const page = await env.DB.prepare(
        "SELECT p.*, u.display_name AS author_name FROM pages p JOIN users u ON u.id=p.author_id WHERE p.slug=? AND p.status='published'"
      ).bind(slug).first();
      if (!page) return err("公開ページが見つかりません", 404);

      const tok = getToken(req);
      let viewer = { user_id: null, purchased: false, balance: null };
      if (tok) {
        const u = await env.DB.prepare("SELECT id FROM users WHERE id=?").bind(tok).first();
        if (u) {
          const pur = await env.DB.prepare("SELECT 1 ok FROM purchases WHERE user_id=? AND page_id=?").bind(tok, page.id).first();
          const wal = await env.DB.prepare("SELECT balance FROM wallets WHERE user_id=?").bind(tok).first();
          viewer = { user_id: tok, purchased: !!pur, balance: wal?.balance ?? 0 };
        }
      }
      return json({ page, viewer });
    }

    if (url.pathname === "/api/purchase" && req.method === "POST") {
      const auth = await requireUser(req, env);
      if (!auth.ok) return auth.res;

      const body = await req.json().catch(() => null);
      if (!body?.page_id) return err("page_id が必要です", 400);

      const page = await env.DB.prepare("SELECT * FROM pages WHERE id=? AND status='published'").bind(body.page_id).first();
      if (!page) return err("購入対象のページが見つかりません", 404);

      const price = Math.max(0, Number(page.price_coins || 0) | 0);
      if (price === 0) return json({ ok: true, free: true });
      if (page.author_id === auth.user.user_id) return err("自分の作品は購入できません", 400);

      const already = await env.DB.prepare("SELECT 1 ok FROM purchases WHERE user_id=? AND page_id=?").bind(auth.user.user_id, page.id).first();
      if (already) return json({ ok: true, already: true });

      await env.DB.prepare("INSERT OR IGNORE INTO wallets (user_id, balance, updated_at) VALUES (?,?,?)").bind(page.author_id, 0, now()).run();

      const t = now();
      const debit = await env.DB.prepare(
        "UPDATE wallets SET balance = balance - ?, updated_at=? WHERE user_id=? AND balance >= ?"
      ).bind(price, t, auth.user.user_id, price).run();

      if (debit.meta.changes !== 1) return err("コイン残高が足りません", 400);

      await env.DB.batch([
        env.DB.prepare("UPDATE wallets SET balance = balance + ?, updated_at=? WHERE user_id=?").bind(price, t, page.author_id),
        env.DB.prepare("INSERT INTO purchases (user_id, page_id, price_coins, purchased_at) VALUES (?,?,?,?)").bind(auth.user.user_id, page.id, price, t),
        env.DB.prepare(
          "INSERT INTO coin_transactions (id, type, from_user_id, to_user_id, amount, page_id, created_at) VALUES (?,?,?,?,?,?,?)"
        ).bind(rid("t_"), "purchase", auth.user.user_id, page.author_id, price, page.id, t),
      ]);

      return json({ ok: true });
    }

    return err("Not found", 404);
  },
};
