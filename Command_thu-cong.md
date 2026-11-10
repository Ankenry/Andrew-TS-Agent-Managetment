<!-- Bot telegram đọc notifications -->
cd "/home/avada/TS Work Space/Andrew TS Tools"
node scripts/ticket-notification-to-telegram.mjs --watch

<!-- Trong .env_my, ưu tiên cấu hình cùng AI/knowledge base với TS Elite -->
<!-- TS_ELITE_EXT_TOKEN=<token từ luồng https://ts2.avada.net/ext-login> -->
<!-- TS_ELITE_BASE_URL=https://ts2.avada.net -->
<!-- Nếu không có token trên, bot dùng OPENAI_API_KEY hiện có nhưng vẫn đọc ticket/comment theo link/ID. -->

<!-- Trong Telegram: gửi hoặc reply vào notification có Helpdesk link, rồi hỏi AI. -->
<!-- Có thể gửi trực tiếp: "Check ticket CHATTY-260819-hzWYJV giúp mình". -->
