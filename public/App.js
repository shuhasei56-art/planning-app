import { sendMessageStream } from './api.js';
import { parseMarkdown } from './markdown.js';

export class App {
    constructor() {
        this.messagesContainer = document.getElementById('messages');
        this.inputField = document.getElementById('user-input');
        this.sendButton = document.getElementById('send-button');

        this.init();
    }

    init() {
        this.sendButton.addEventListener('click', () => this.handleSend());
        this.inputField.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') this.handleSend();
        });
    }

    appendMessage(role, text) {
        const div = document.createElement('div');
        div.className = `message ${role}`;
        div.innerHTML = parseMarkdown(text);
        this.messagesContainer.appendChild(div);
        this.scrollToBottom();
        return div;
    }

    scrollToBottom() {
        this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }

    async handleSend() {
        const text = this.inputField.value.trim();
        if (!text) return;

        // ユーザーのメッセージを表示
        this.appendMessage('user', text);
        this.inputField.value = '';
        this.sendButton.disabled = true;

        // AIの返答用コンテナを作成
        const aiMessageDiv = this.appendMessage('ai', '');
        let fullResponse = '';

        // ストリーミングで文字を受信するたびに呼ばれるコールバック
        await sendMessageStream(text, (chunk) => {
            fullResponse += chunk;
            aiMessageDiv.innerHTML = parseMarkdown(fullResponse);
            this.scrollToBottom();
        });

        this.sendButton.disabled = false;
        this.inputField.focus();
    }
}
