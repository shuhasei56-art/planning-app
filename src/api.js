// Workerのエンドポイント（ローカル開発時はWranglerのURL）
const API_URL = '/api/chat'; 

export async function sendMessageStream(message, onChunk) {
    try {
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message })
        });

        if (!response.ok) throw new Error('Network response was not ok');

        // ストリーミングデータを読み込む
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let done = false;

        while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;
            if (value) {
                const chunk = decoder.decode(value, { stream: true });
                onChunk(chunk); // 文字列の断片をUIに渡す
            }
        }
    } catch (error) {
        console.error('API Error:', error);
        onChunk('\n[エラーが発生しました]');
    }
}
