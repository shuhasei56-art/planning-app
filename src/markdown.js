// Tiny markdown renderer (DEFAULT EXPORT ONLY)

function renderMarkdown(md) {
  if (!md) return "";
  const esc = (s) => s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  let html = md.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${esc(code)}</code></pre>`);
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => `<img alt="${esc(alt)}" src="${esc(url)}" />`);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(text)}</a>`);
  html = html.replace(/^###\s+(.+)$/gm, (_, t) => `<h3>${esc(t)}</h3>`);
  html = html.replace(/^##\s+(.+)$/gm, (_, t) => `<h2>${esc(t)}</h2>`);
  html = html.replace(/^#\s+(.+)$/gm, (_, t) => `<h1>${esc(t)}</h1>`);
  html = html.replace(/`([^`]+)`/g, (_, c) => `<code>${esc(c)}</code>`);
  html = html.split(/\n\n+/).map(block => {
    if (/^<h\d|^<pre|^<img|^<ul|^<ol|^<blockquote|^<p|^<div/.test(block.trim())) return block;
    const lines = block.split(/\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return "";
    return `<p>${lines.map(esc).join("<br/>")}</p>`;
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

const markdownModule = { renderMarkdown, excerpt };
export default markdownModule;
