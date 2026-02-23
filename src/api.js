// Simple API client. Worker serves /api/* endpoints.
//
// IMPORTANT:
// Some build environments may treat modules as CJS and disallow named exports.
// To avoid that, this file uses a DEFAULT EXPORT ONLY.

async function api(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await res.text();
  let data;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  if (!res.ok) {
    const msg = data?.error || data?.message || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// Local "auth": create or reuse a user id stored in localStorage.
// Replace with real auth later.
function getLocalUser() {
  const raw = localStorage.getItem("sp_user");
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}
function setLocalUser(u) {
  localStorage.setItem("sp_user", JSON.stringify(u));
}
function clearLocalUser() {
  localStorage.removeItem("sp_user");
}

export default { api, getLocalUser, setLocalUser, clearLocalUser };
