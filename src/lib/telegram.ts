// Нагадування оператору через Telegram-бот (PRD §11, MVP-канал).
// Бот не може написати покупцю першим — повідомлення йдуть на chat_id
// оператора; прямі канали до покупця — окремим етапом.

export type Notifier = {
  send(text: string): Promise<void>;
};

export type TelegramNotifierOptions = {
  botToken: string;
  chatId: string;
  fetch?: typeof fetch;
};

export function createTelegramNotifier(options: TelegramNotifierOptions): Notifier {
  const fetchImpl = options.fetch ?? fetch;

  return {
    async send(text) {
      const response = await fetchImpl(
        `https://api.telegram.org/bot${options.botToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: options.chatId, text }),
        },
      );
      if (!response.ok) {
        // Токен присутній лише в URL запиту — у повідомлення помилки не потрапляє
        throw new Error(`Telegram sendMessage ${response.status}`);
      }
    },
  };
}
