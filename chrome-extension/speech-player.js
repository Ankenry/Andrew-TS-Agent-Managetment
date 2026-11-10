// Read-aloud for the chat bot, shared by the extension widget and the TS Management web. The host supplies
// `prepare(payload)` and `audio(id, index)` (both reach the TS Management web server, which synthesizes with the
// offline Piper voice); this module parses the "đọc" commands, plays the segments in order on the device that is
// open, and falls back to the browser's own voice when Piper audio cannot be fetched. No AI call, no online TTS.
globalThis.SpeechPlayer = (() => {
  const css = `
    .speech-button { display:inline-flex;align-items:center;gap:4px;align-self:flex-start;border:1px solid var(--chat-line,rgba(124,58,237,.16));border-radius:999px;cursor:pointer;padding:2px 9px;color:var(--chat-accent-text,#6d28d9);background:var(--chat-soft,rgba(124,58,237,.09));font-size:10px;font-weight:800;line-height:1.6; }
    .speech-button:hover { border-color:var(--chat-accent,#7c3aed); }
    .speech-button.playing,.speech-button.loading { color:#fff;background:var(--chat-accent,#7c3aed);border-color:transparent; }
    .speech-button.loading { cursor:progress; }
    .message-meta { display:flex;flex-wrap:wrap;align-items:center;gap:8px; }
  `;
  const LABELS = { idle: "🔊 Đọc", loading: "… Đang tạo tiếng", playing: "⏹ Dừng đọc" };

  // "đọc" / "đọc 49" / "đọc báo cáo số 49" / "dừng" — anything else is a normal chat message.
  function parseCommand(text) {
    const value = String(text || "").trim().toLowerCase().replace(/[.!]+$/, "").replace(/\s+/g, " ");
    if (/^(dừng|dừng đọc|ngừng đọc|thôi đọc|dung doc|stop)$/.test(value)) return { type: "stop" };
    const read = /^(?:đọc|doc)(?: (?:báo cáo |bao cao )?(?:số |so )?(\d{1,6}))?$/.exec(value);
    if (!read) return null;
    return read[1] ? { type: "report", number: Number(read[1]) } : { type: "last" };
  }

  function create({ prepare, audio }) {
    let context = null; let token = 0; let node = null; let release = null;
    const setState = (onState, state) => { try { onState?.(state); } catch { /* UI only */ } };

    // Must run inside the tap/Enter that asked for the reading (iOS only starts audio from a user gesture).
    function unlock() {
      try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (AudioContextClass) { context ||= new AudioContextClass(); if (context.state === "suspended") void context.resume(); }
        if (window.speechSynthesis && !window.speechSynthesis.speaking) window.speechSynthesis.cancel();
      } catch { /* the fallback voice may still work */ }
    }
    function stop() {
      token += 1;
      try { node?.stop(); } catch { /* already ended */ }
      node = null;
      try { window.speechSynthesis?.cancel(); } catch { /* not supported */ }
      const done = release; release = null; done?.();
    }
    const playBuffer = (buffer, mine) => new Promise((resolve) => {
      if (mine !== token) return resolve();
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      source.onended = () => { if (node === source) node = null; resolve(); };
      node = source; source.start();
    });
    const decode = (data) => new Promise((resolve, reject) => { const promise = context.decodeAudioData(data, resolve, reject); if (promise?.then) promise.then(resolve, reject); });
    function speakWithBrowser(segments, mine) {
      return new Promise((resolve, reject) => {
        const synth = window.speechSynthesis;
        if (!synth || typeof SpeechSynthesisUtterance === "undefined") return reject(new Error("Thiết bị này không có giọng đọc."));
        const voice = synth.getVoices().find((item) => /^vi\b/i.test(item.lang)) || null;
        let index = 0;
        const next = () => {
          if (mine !== token || index >= segments.length) return resolve();
          const utterance = new SpeechSynthesisUtterance(segments[index]); index += 1;
          utterance.lang = "vi-VN"; if (voice) utterance.voice = voice;
          utterance.onend = next; utterance.onerror = () => resolve();
          synth.speak(utterance);
        };
        next();
      });
    }

    // payload: { report: number } or { text }. Resolves with the prepared info ({ display, number, voice, … }) once
    // the reading has started; onState follows "loading" → "playing" → "idle".
    async function speak(payload, onState) {
      stop(); unlock();
      const mine = token; let finished = false;
      const finish = () => { if (finished) return; finished = true; setState(onState, "idle"); };
      release = finish;
      setState(onState, "loading");
      let info;
      try { info = await prepare(payload); } catch (error) { if (release === finish) release = null; finish(); throw error; }
      if (mine !== token) return info;
      const run = async () => {
        const segments = info.segments || [];
        let usedBrowser = info.voice !== "piper" || !context;
        if (!usedBrowser) {
          const pending = new Map();
          const load = (index) => { if (!pending.has(index)) pending.set(index, audio(info.id, index).then(decode)); return pending.get(index); };
          for (let index = 0; index < segments.length && mine === token; index += 1) {
            let buffer;
            try { buffer = await load(index); } catch (error) {
              // Piper audio unavailable: let the browser's voice read what is left.
              if (mine === token) { setState(onState, "playing"); await speakWithBrowser(segments.slice(index), mine).catch(() => {}); }
              return;
            }
            if (index + 1 < segments.length) load(index + 1).catch(() => {});
            if (mine !== token) return;
            setState(onState, "playing");
            await playBuffer(buffer, mine);
          }
          return;
        }
        setState(onState, "playing");
        await speakWithBrowser(segments, mine);
      };
      void run().catch(() => {}).finally(() => { if (mine === token) { if (release === finish) release = null; finish(); } });
      return info;
    }

    // A speaker button for one answer; getPayload() returns { text } or { report } at click time.
    function button(getPayload) {
      const control = document.createElement("button"); control.type = "button"; control.className = "speech-button";
      let state = "idle";
      const paint = (next) => { state = next; control.className = `speech-button${next === "idle" ? "" : ` ${next}`}`; control.textContent = LABELS[next]; control.setAttribute("aria-label", next === "idle" ? "Đọc câu trả lời này" : "Dừng đọc"); };
      paint("idle");
      control.addEventListener("click", () => {
        if (state !== "idle") { stop(); return; }
        speak(getPayload(), paint).catch((error) => { paint("idle"); control.title = `Không đọc được: ${error.message}`; });
      });
      return control;
    }

    // Runs a parsed command. host: { say(role, text, extra) → appends a chat message, lastAnswer() → { text } | null }.
    async function handleCommand(command, host) {
      unlock();
      if (command.type === "stop") { stop(); host.say("assistant", "Đã dừng đọc.", { speechNote: true }); return; }
      if (command.type === "last") {
        const last = host.lastAnswer();
        if (!last?.text) { host.say("assistant", "Chưa có câu trả lời nào để đọc. Gõ “đọc <số>” để nghe một báo cáo của Hanlead.", { speechNote: true }); return; }
        try { await speak({ text: last.text }); host.say("assistant", "Đang đọc câu trả lời gần nhất. Gõ “dừng” để dừng đọc.", { speechNote: true }); }
        catch (error) { host.say("assistant", `Không đọc được: ${error.message}`, { speechNote: true }); }
        return;
      }
      try {
        const info = await speak({ report: command.number });
        host.say("assistant", `Báo cáo số ${info.number}\n\n${info.display}`, { report: info.number });
        host.say("assistant", `Đang đọc báo cáo số ${info.number}${info.voice === "piper" ? "" : " bằng giọng của trình duyệt"}. Gõ “dừng” để dừng đọc.`, { speechNote: true });
      } catch (error) { host.say("assistant", `Không đọc được báo cáo số ${command.number}: ${error.message}`, { speechNote: true }); }
    }

    return { unlock, speak, stop, button, handleCommand };
  }

  return { css, parseCommand, create };
})();
