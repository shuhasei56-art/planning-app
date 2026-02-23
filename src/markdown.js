// Tiny markdown renderer (very small subset) to avoid heavy deps.
//
// IMPORTANT:
// Some build environments may treat modules as CJS and disallow named exports.
// To avoid that, this file uses a DEFAULT EXPORT ONLY.
//
// Supports: headings (#, ##, ###), paragraphs, links, images, code blocks (```), inline code.

function renderMarkdown(md) {
  if (!md) return "";
  const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  // code blocks
  let html = md.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${esc(code)}</code></pre>`);
  // images ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => `<img alt="${esc(alt)}" src="${esc(url)}" />`);
  // links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(text)}</a>`);
  // headings
  html = html.replace(/^###\s+(.+)$/gm, (_, t) => `<h3>${esc(t)}</h3>`);
  html = html.replace(/^##\s+(.+)$/gm, (_, t) => `<h2>${esc(t)}</h2>`);
  html = html.replace(/^#\s+(.+)$/gm, (_, t) => `<h1>${esc(t)}</h1>`);
  // inline code
  html = html.replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`);
  // paragraphs
  html = html.split(/\n\n+/).map(block => {
    if (/^<h\d|^<pre|^<img|^<ul|^<ol|^<blockquote|^<p|^<div/.test(block.trim())) return block;
    const lines = block.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return "";
    const joined = lines.map(esc).join("<br/>");
    return `<p>${joined}</p>`;
  }).join("\n");
  return html;
}

function excerpt(md, maxChars = 600) {
  const s = (md || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .trim();
  return s.length > maxChars ? s.slice(0, maxChars) + "…" : s;
}

export default { renderMarkdown, excerpt };
