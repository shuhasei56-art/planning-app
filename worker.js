export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // CORS対応
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                }
            });
        }

        // APIエンドポイントの処理
        if (request.method === 'POST' && url.pathname === '/api/chat') {
            try {
                const { message } = await request.json();

                // ------------------------------------------------------------------
                // 【重要】ここで外部のLLM API（Gemini等）にリクエストを送ります。
                // 返答を高速化するためには、外部APIのオプションで `stream: true` を設定し、
                // そのストリームをそのままフロントエンドに流す（pipeTo）のがベストプラクティスです。
                // 
                // 以下は、ストリーミングの挙動をテストするためのモック（ダミー）実装です。
                // ------------------------------------------------------------------
                
                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const encoder = new TextEncoder();

                // 非同期でダミーのテキストを少しずつ送信する処理
                ctx.waitUntil((async () => {
                    const replyText = `あなたが言ったのは「${message}」ですね。\n標準的なアシスタントとしてお答えします。`;
                    for (let i = 0; i < replyText.length; i++) {
                        await writer.write(encoder.encode(replyText[i]));
                        await new Promise(resolve => setTimeout(resolve, 50)); // 擬似的な遅延
                    }
                    await writer.close();
                })());

                return new Response(readable, {
                    headers: {
                        'Content-Type': 'text/event-stream',
                        'Access-Control-Allow-Origin': '*'
                    }
                });

            } catch (error) {
                return new Response('Error', { status: 500 });
            }
        }

        // 静的ファイルの配信（Cloudflare Pagesを使用する場合は不要）
        return new Response("Not Found", { status: 404 });
    }
};
