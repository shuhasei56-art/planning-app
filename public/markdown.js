// 簡易的なマークダウンパーサー（必要に応じてmarked.jsなどのライブラリに置き換えてください）
export function parseMarkdown(text) {
    if (!text) return '';
    let html = text.replace(/\n/g, '<br>'); // 改行
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); // 太字
    return html;
}
