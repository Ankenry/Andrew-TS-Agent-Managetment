// Merges automatic ticket reviews (skills/check-ticket/scripts/history.mjs) into the saved chat-bot conversations.
// Shared by the extension (background + widget) and the TS Management web. Storage only: it cannot start
// a review, call AI or write a ticket comment.
globalThis.AutomaticReviewHistory = (() => {
  const MAX_MANUAL_CONVERSATIONS = 30;
  const MAX_AUTOMATIC_CONVERSATIONS = 30;
  const MAX_MESSAGES_PER_CONVERSATION = 100;
  const valid = (conversation) => Boolean(conversation) && typeof conversation.chatId === "string" && Array.isArray(conversation.messages);
  const isAutomatic = (conversation) => conversation?.origin === "automatic";
  // Fields a client must carry over when it saves a conversation that started as an automatic review.
  const originFields = (conversation) => (isAutomatic(conversation) ? { origin: "automatic", automatic: conversation.automatic || {} } : {});

  // Manual chats and automatic reviews have separate limits, so a busy ticket day cannot push chats out.
  function cap(conversations) {
    let manual = 0; let automatic = 0;
    return (Array.isArray(conversations) ? conversations : []).filter(valid)
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .filter((conversation) => (isAutomatic(conversation) ? automatic++ < MAX_AUTOMATIC_CONVERSATIONS : manual++ < MAX_MANUAL_CONVERSATIONS));
  }

  // Messages typed by the user inside an automatic conversation are kept; only the review's own messages are refreshed.
  function merge(saved, incoming, { dismissed = [] } = {}) {
    const hidden = new Set(dismissed);
    const before = (Array.isArray(saved) ? saved : []).filter(valid);
    const byId = new Map(before.map((conversation) => [conversation.chatId, conversation]));
    let changed = false;
    for (const item of Array.isArray(incoming) ? incoming : []) {
      if (!valid(item) || !isAutomatic(item) || hidden.has(item.chatId)) continue;
      const current = byId.get(item.chatId);
      if (current && current.automatic?.revision === item.automatic?.revision) continue;
      const own = (current?.messages || []).filter((message) => !message?.auto);
      byId.set(item.chatId, {
        ...item,
        messages: [...item.messages, ...own].slice(-MAX_MESSAGES_PER_CONVERSATION),
        createdAt: current?.createdAt || item.createdAt,
        updatedAt: Math.max(Number(item.updatedAt || 0), own.length ? Number(current.updatedAt || 0) : 0),
      });
      changed = true;
    }
    const conversations = cap([...byId.values()]);
    return { conversations, changed: changed || conversations.length !== before.length };
  }

  const STATUS_LABELS = { running: "Đang check", done: "Đã comment", uncertain: "Chưa xác nhận comment", failed: "Cần kiểm tra" };
  const statusLabel = (conversation) => (isAutomatic(conversation) ? `Auto check · ${conversation.automatic?.statusLabel || STATUS_LABELS[conversation.automatic?.status] || "Đã ghi nhận"}` : "");

  return { MAX_MANUAL_CONVERSATIONS, MAX_AUTOMATIC_CONVERSATIONS, valid, isAutomatic, originFields, cap, merge, statusLabel };
})();
