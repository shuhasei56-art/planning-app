// Cloudflare Worker for Super Planner Books
// - Serves React build assets (./build) via assets config
// - Provides API endpoints under /api/*
// - Uses D1 for DB and R2 for image storage
//
// Bindings needed in wrangler.jsonc:
// - D1: DB
// - R2: BUCKET
//
// NOTE: This sample uses a simple bearer token (not secure for production).
// Replace with real auth (OAuth/JWT) later.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(init.headers || {}) },
  });
}

function err(message, status = 400) {
  return json({ error: message }, { status, headers: CORS_HEADERS });
}

function now() {
  return Math.floor(Date.now());
}

function randomId(prefix = "") {
  return prefix + crypto.randomUUID();
}

function getToken(req) {
  const h = req.headers.get("Authorization") || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

// Very simple token mapping: token == user_id (demo).
// In real apps, use signed tokens.
async function requireUser(req, env) {
  const token = getToken(req);
  if (!token) return { ok: false, res: err("ログインが必要です", 401) };
  const user_id = token;
  const u = await env.DB.prepare("SELECT id, display_name FROM users WHERE id = ?").bind(user_id).first();
  if (!u) return { ok: false, res: err("無効なトークンです", 401) };
  const w = await env.DB.prepare("SELECT balance FROM wallets WHERE user_id = ?").bind(user_id).first();
  return { ok: true, user: { user_id: u.id, display_name: u.display_name, balance: w?.balance ?? 0 } };
}

async function ensureUser(env, display_name) {
  const user_id = randomId("u_");
  const created_at = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?,?,?)").bind(user_id, display_name, created_at),
    env.DB.prepare("INSERT INTO wallets (user_id, balance, updated_at) VALUES (?,?,?)").bind(user_id, 1000, created_at),
    env.DB.prepare("INSERT INTO coin_transactions (id, type, from_user_id, to_user_id, amount, page_id, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(randomId("t_"), "initial_grant", null, user_id, 1000, null, created_at),
  ]);
  return { user_id, display_name, token: user_id, balance: 1000 };
}

function safeFilename(name) {
  return (name || "file")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
}

async function handleUpload(req, env) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;

  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) return err("multipart/form-data が必要です", 400);

  const form = await req.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") return err("file が見つかりません", 400);

  const maxBytes = 5 * 1024 * 1024;
  if (file.size > maxBytes) return err("画像が大きすぎます（最大5MB）", 400);

  const mime = file.type || "application/octet-stream";
  if (!mime.startsWith("image/")) return err("画像ファイルのみ対応です", 400);

  const key = `${auth.user.user_id}/${now()}_${safeFilename(file.name)}`;
  await env.BUCKET.put(key, file.stream(), { httpMetadata: { contentType: mime } });

  // Serve via Worker route
  const url = new URL(req.url);
  const publicUrl = `${url.origin}/api/img/${encodeURIComponent(key)}`;
  return json({ url: publicUrl }, { headers: CORS_HEADERS });
}

async function handleImage(req, env, key) {
  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(obj.body, { headers });
}

async function handleCreatePage(req, env) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;

  const body = await req.json().catch(() => null);
  if (!body) return err("JSON body が必要です", 400);

  const id = randomId("p_");
  const created_at = now();
  const title = (body.title || "").trim() || "無題";
  const slug = (body.slug || "").trim();
  const content = body.content || "";
  const cover = body.cover_image_url || null;
  const price = Math.max(0, Number(body.price_coins || 0) | 0);

  if (!slug) return err("slug が必要です（空ならフロントで自動生成してください）", 400);

  try {
    await env.DB.prepare(
      "INSERT INTO pages (id, author_id, title, slug, content, cover_image_url, price_coins, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(id, auth.user.user_id, title, slug, content, cover, price, "draft", created_at, created_at).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return err("そのスラッグは既に使われています", 409);
    return err("作成に失敗しました", 500);
  }

  const page = await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first();
  return json({ page }, { headers: CORS_HEADERS });
}

async function handleUpdatePage(req, env, id) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;

  const page = await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first();
  if (!page) return err("ページが見つかりません", 404);
  if (page.author_id !== auth.user.user_id) return err("権限がありません", 403);

  const body = await req.json().catch(() => null);
  if (!body) return err("JSON body が必要です", 400);

  const title = (body.title || "").trim() || "無題";
  const slug = (body.slug || "").trim() || page.slug;
  const content = body.content || "";
  const cover = body.cover_image_url || null;
  const price = Math.max(0, Number(body.price_coins || 0) | 0);
  const updated_at = now();

  try {
    await env.DB.prepare(
      "UPDATE pages SET title=?, slug=?, content=?, cover_image_url=?, price_coins=?, updated_at=? WHERE id=?"
    ).bind(title, slug, content, cover, price, updated_at, id).run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) return err("そのスラッグは既に使われています", 409);
    return err("更新に失敗しました", 500);
  }

  const updated = await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first();
  return json({ page: updated }, { headers: CORS_HEADERS });
}

async function handleGetMine(req, env) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;
  const rows = await env.DB.prepare(
    "SELECT * FROM pages WHERE author_id = ? ORDER BY updated_at DESC"
  ).bind(auth.user.user_id).all();
  return json({ pages: rows.results || [] }, { headers: CORS_HEADERS });
}

async function handleGetPublicList(req, env) {
  const rows = await env.DB.prepare(
    "SELECT p.*, u.display_name AS author_name FROM pages p JOIN users u ON u.id = p.author_id WHERE p.status='published' ORDER BY p.published_at DESC, p.updated_at DESC LIMIT 50"
  ).all();
  // keep content for excerpt
  return json({ pages: rows.results || [] }, { headers: CORS_HEADERS });
}

async function handleGetPage(req, env, id) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;
  const page = await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first();
  if (!page) return err("ページが見つかりません", 404);
  if (page.author_id !== auth.user.user_id) return err("権限がありません", 403);
  return json({ page }, { headers: CORS_HEADERS });
}

async function handlePublish(req, env, id) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;

  const page = await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first();
  if (!page) return err("ページが見つかりません", 404);
  if (page.author_id !== auth.user.user_id) return err("権限がありません", 403);

  const t = now();
  await env.DB.prepare(
    "UPDATE pages SET status='published', published_at=?, updated_at=? WHERE id=?"
  ).bind(t, t, id).run();

  const updated = await env.DB.prepare("SELECT * FROM pages WHERE id = ?").bind(id).first();
  return json({ page: updated }, { headers: CORS_HEADERS });
}

async function handlePublicBySlug(req, env, slug, reqUser) {
  const page = await env.DB.prepare(
    "SELECT p.*, u.display_name AS author_name FROM pages p JOIN users u ON u.id = p.author_id WHERE p.slug = ? AND p.status='published'"
  ).bind(slug).first();
  if (!page) return err("公開ページが見つかりません", 404);

  let viewer = { user_id: null, purchased: false, balance: null };
  if (reqUser?.user_id) {
    const pur = await env.DB.prepare("SELECT 1 as ok FROM purchases WHERE user_id=? AND page_id=?").bind(reqUser.user_id, page.id).first();
    const wal = await env.DB.prepare("SELECT balance FROM wallets WHERE user_id=?").bind(reqUser.user_id).first();
    viewer = { user_id: reqUser.user_id, purchased: !!pur, balance: wal?.balance ?? 0 };
  }
  return json({ page, viewer }, { headers: CORS_HEADERS });
}

async function handleMe(req, env) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;
  return json({ me: auth.user }, { headers: CORS_HEADERS });
}

async function handlePurchase(req, env) {
  const auth = await requireUser(req, env);
  if (!auth.ok) return auth.res;
  const body = await req.json().catch(() => null);
  if (!body?.page_id) return err("page_id が必要です", 400);

  const page = await env.DB.prepare(
    "SELECT p.*, u.display_name AS author_name FROM pages p JOIN users u ON u.id = p.author_id WHERE p.id = ? AND p.status='published'"
  ).bind(body.page_id).first();
  if (!page) return err("購入対象のページが見つかりません", 404);

  const price = Math.max(0, Number(page.price_coins || 0) | 0);
  if (price === 0) {
    // free: mark as purchased (optional) - we won't create purchase
    return json({ ok: true, free: true }, { headers: CORS_HEADERS });
  }
  if (page.author_id === auth.user.user_id) return err("自分の作品は購入できません", 400);

  // already purchased?
  const already = await env.DB.prepare("SELECT 1 as ok FROM purchases WHERE user_id=? AND page_id=?").bind(auth.user.user_id, page.id).first();
  if (already) return json({ ok: true, already: true }, { headers: CORS_HEADERS });

  // Ensure wallets exist
  await env.DB.prepare("INSERT OR IGNORE INTO wallets (user_id, balance, updated_at) VALUES (?,?,?)").bind(page.author_id, 0, now()).run();

  // Conditional debit to avoid negative
  const t = now();
  const debit = await env.DB.prepare(
    "UPDATE wallets SET balance = balance - ?, updated_at=? WHERE user_id = ? AND balance >= ?"
  ).bind(price, t, auth.user.user_id, price).run();

  if (debit.meta.changes !== 1) return err("コイン残高が足りません", 400);

  await env.DB.batch([
    env.DB.prepare("UPDATE wallets SET balance = balance + ?, updated_at=? WHERE user_id = ?").bind(price, t, page.author_id),
    env.DB.prepare("INSERT INTO purchases (user_id, page_id, price_coins, purchased_at) VALUES (?,?,?,?)").bind(auth.user.user_id, page.id, price, t),
    env.DB.prepare("INSERT INTO coin_transactions (id, type, from_user_id, to_user_id, amount, page_id, created_at) VALUES (?,?,?,?,?,?,?)")
      .bind(randomId("t_"), "purchase", auth.user.user_id, page.author_id, price, page.id, t),
  ]);

  return json({ ok: true }, { headers: CORS_HEADERS });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response("", { status: 204, headers: CORS_HEADERS });
    }

    // API routes
    if (url.pathname.startsWith("/api/")) {
      try {
        // /api/img/<key>
        if (url.pathname.startsWith("/api/img/")) {
          const key = decodeURIComponent(url.pathname.replace("/api/img/", ""));
          return handleImage(req, env, key);
        }

        if (url.pathname === "/api/users" && req.method === "POST") {
          const body = await req.json().catch(() => null);
          const display_name = (body?.display_name || "ユーザー").toString().slice(0, 40);
          const u = await ensureUser(env, display_name);
          return json({ user_id: u.user_id, display_name: u.display_name, token: u.token, balance: u.balance }, { headers: CORS_HEADERS });
        }

        if (url.pathname === "/api/me" && req.method === "GET") return handleMe(req, env);

        if (url.pathname === "/api/upload" && req.method === "POST") return handleUpload(req, env);

        if (url.pathname === "/api/pages" && req.method === "POST") return handleCreatePage(req, env);
        if (url.pathname === "/api/pages/mine" && req.method === "GET") return handleGetMine(req, env);
        if (url.pathname === "/api/pages/public" && req.method === "GET") return handleGetPublicList(req, env);

        // /api/pages/:id
        const m1 = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
        if (m1 && req.method === "GET") return handleGetPage(req, env, m1[1]);
        if (m1 && req.method === "PUT") return handleUpdatePage(req, env, m1[1]);

        // /api/pages/:id/publish
        const m2 = url.pathname.match(/^\/api\/pages\/([^/]+)\/publish$/);
        if (m2 && req.method === "POST") return handlePublish(req, env, m2[1]);

        // /api/p/:slug (public)
        const m3 = url.pathname.match(/^\/api\/p\/([^/]+)$/);
        if (m3 && req.method === "GET") {
          // optional viewer
          const tok = getToken(req);
          let reqUser = null;
          if (tok) {
            const u = await env.DB.prepare("SELECT id, display_name FROM users WHERE id=?").bind(tok).first();
            if (u) reqUser = { user_id: u.id, display_name: u.display_name };
          }
          return handlePublicBySlug(req, env, decodeURIComponent(m3[1]), reqUser);
        }

        if (url.pathname === "/api/purchase" && req.method === "POST") return handlePurchase(req, env);

        return err("Not found", 404);
      } catch (e) {
        return err("サーバーエラー: " + (e?.message || String(e)), 500);
      }
    }

    // Non-API: serve static assets via `assets` in wrangler.jsonc
    // If assets are configured, Cloudflare will serve them automatically when `main` is set.
    return new Response("Not configured. Build your React app and deploy with assets.", { status: 404 });
  },
};
