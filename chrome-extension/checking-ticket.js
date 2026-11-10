// Read-only view of Hachimi's check-ticket runs for the "Checking ticket" section of the chat screen.
// Shared by the extension background and the TS Management web server: both read the local tracing web
// (scripts/hachimi-trace-web.mjs) and hand these plain views to their UI. Nothing here starts a review,
// calls AI or writes a ticket comment.
globalThis.CheckingTicket = (() => {
  // Runs that check a ticket. Widget chat turns are left out: they are the conversations themselves.
  const SOURCES = ["automatic", "manual"];
  const SESSION_LIMIT = 40;
  const MAX_EVENT_TEXT = 6000;
  const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/;
  const STATUS_LABELS = { running: "Đang check", done: "Đã check xong", uncertain: "Chưa xác nhận comment", failed: "Cần kiểm tra", cancelled: "Đã hủy" };
  const SOURCE_LABELS = { automatic: "Auto check", manual: "Check thủ công" };
  const KIND_LABELS = { start: "Bắt đầu", phase: "Pha", waiting: "Đang chờ", text: "Trả lời", thinking: "Phân tích", tool: "Công cụ", observation: "Ghi nhận", note: "Ghi chú", warning: "Cảnh báo", result: "Kết quả", done: "Hoàn tất", error: "Lỗi", cancelled: "Đã hủy" };

  function status(row) {
    if (!row?.terminal) return "running";
    if (row.status === "done") return "done";
    if (row.status === "uncertain") return "uncertain";
    if (row.status === "cancelled") return "cancelled";
    return "failed";
  }

  // Automatic reviews reuse the History conversation `auto-<ticket id>` (automatic-history.js), so questions
  // asked in this section and in History stay in one thread.
  function chatId(row) {
    const externalId = String(row?.external_id || "");
    if (row?.source === "automatic" && SAFE_ID.test(externalId)) return `auto-${externalId}`.slice(0, 100);
    return `check-${row?.source || "run"}-${externalId}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100);
  }

  function session(row) {
    if (!row || !Number.isInteger(Number(row.id))) return null;
    const state = status(row);
    const ticket = String(row.ticket_reference || "");
    const subject = String(row.subject || "");
    const externalId = String(row.external_id || "");
    return {
      id: Number(row.id), source: String(row.source || ""), sourceLabel: SOURCE_LABELS[row.source] || String(row.source || ""), externalId,
      ticket, subject, category: String(row.category || ""), phase: String(row.phase || ""),
      status: state, statusLabel: STATUS_LABELS[state], running: state === "running",
      startedAt: row.started_at || row.created_at || "", endedAt: row.ended_at || "",
      eventCount: Number(row.event_count) || 0, lastText: String(row.last_text || "").slice(0, 200),
      chatId: chatId(row),
      // The automatic controller keys its jobs by the internal ticket id.
      selectedTicket: ticket ? { ...(row.source === "automatic" && SAFE_ID.test(externalId) ? { id: externalId } : {}), ticketId: ticket, subject } : null,
    };
  }

  // Newest first, runs still in progress on top.
  function sessions(rows) {
    return (Array.isArray(rows) ? rows : []).map(session).filter((item) => item && SOURCES.includes(item.source))
      .sort((left, right) => Number(right.running) - Number(left.running) || String(right.startedAt).localeCompare(String(left.startedAt)))
      .slice(0, SESSION_LIMIT);
  }

  function event(row) {
    const kind = String(row?.kind || "note");
    const text = String(row?.text || "");
    return { seq: Number(row?.seq) || 0, kind, label: KIND_LABELS[kind] || kind, phase: String(row?.phase || ""), at: row?.at || "", text: text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}\n…` : text };
  }
  const events = (rows) => (Array.isArray(rows) ? rows : []).map(event);

  // `readJson(path)` reads one tracing-web API path; the caller owns transport and error wording.
  function reader(readJson) {
    const list = async () => {
      const lists = await Promise.all(SOURCES.map((source) => readJson(`/api/sessions?source=${encodeURIComponent(source)}&limit=${SESSION_LIMIT}`)));
      return sessions(lists.flatMap((item) => item?.sessions || []));
    };
    // Steps after `after` (a seq, -1 for all) plus the session itself: its row carries the live status.
    const steps = async (id, after = -1) => {
      if (!/^\d{1,12}$/.test(String(id))) throw new Error("Invalid check session.");
      const cursor = Number.isInteger(Number(after)) && Number(after) >= -1 ? Number(after) : -1;
      const [rows, all] = await Promise.all([readJson(`/api/sessions/${id}/events?after=${cursor}`), list()]);
      return { session: all.find((item) => item.id === Number(id)) || null, events: events(rows) };
    };
    return { sessions: list, events: steps };
  }

  return { session, sessions, events, reader };
})();
