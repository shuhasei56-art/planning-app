export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        // 1. CORS対応（ブラウザからの通信を許可する）
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type',
                }
            });
        }

        // 2. APIエンドポイントの処理（チャットの返答を生成する部分）
        if (request.method === 'POST' && url.pathname === '/api/chat') {
            try {
                // ユーザーからのメッセージを受け取る
                const { message } = await request.json();

                // ストリーミング用の準備
                const { readable, writable } = new TransformStream();
                const writer = writable.getWriter();
                const encoder = new TextEncoder();

                // 非同期でダミーのテキストを少しずつ送信する処理
                ctx.waitUntil((async () => {
                    const replyText = `あなたが言ったのは「${message}」ですね。\nこれはストリーミングのテスト返答です。`;
                    
                    // 1文字ずつ送信して、AIがタイピングしているように見せる
                    for (let i = 0; i < replyText.length; i++) {
                        await writer.write(encoder.encode(replyText[i]));
                        await new Promise(resolve => setTimeout(resolve, 50)); // 50ミリ秒の待機
                    }
                    await writer.close();
                })());

                // フロントエンドにストリームとして返す
                return new Response(readable, {
                    headers: {
                        'Content-Type': 'text/event-stream',
                        'Access-Control-Allow-Origin': '*'
                    }
                });

            } catch (error) {
                return new Response('API Error: ' + error.message, { status: 500 });
            }
        }

        // 3. 静的ファイル（フロントエンド画面）の配信とエラーチェック
        try {
            // ルートURL（/）にアクセスされたら、明示的に /index.html を読み込むようにする
            let reqUrl = new URL(request.url);
            let finalRequest = request;
            
            if (reqUrl.pathname === '/') {
                reqUrl.pathname = '/index.html';
                finalRequest = new Request(reqUrl, request);
            }

            // env.ASSETS（静的ファイル）の設定が正しく読み込まれているかチェック
            if (!env.ASSETS) {
                return new Response("【エラー】env.ASSETS が見つかりません。wrangler.jsonc に assets の設定が正しく書かれているか確認してください。", { 
                    status: 500,
                    headers: { "Content-Type": "text/plain; charset=utf-8" }
                });
            }

            // publicフォルダ内のファイル（HTML, CSS, JS）を返す
            return await env.ASSETS.fetch(finalRequest);

        } catch (e) {
            // 何か別のエラーが起きた場合は、そのエラー内容を画面に出す
            return new Response("【内部エラーが発生しました】\n" + e.message, { 
                status: 500,
                headers: { "Content-Type": "text/plain; charset=utf-8" }
            });
        }
    }
};
