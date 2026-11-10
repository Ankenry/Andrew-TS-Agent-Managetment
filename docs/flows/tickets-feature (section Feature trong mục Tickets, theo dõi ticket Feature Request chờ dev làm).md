# Tickets · section Feature (theo dõi ticket Feature Request chờ dev làm)

## Mục đích

Section **Feature** nằm ngay dưới section Dev fix trên trang Tickets (extension Chrome và TS Management web 5088), theo lệnh Đại tá 12/10/2026: "Tôi muốn tạo thêm sections Feature ở Tickets section dưới dev fix và luồng làm việc tương tự dev fix hiện tại (Ticket Feature sẽ lấy từ Feature Request trên help desk)". Nó liệt kê ticket của Andrew có `tsStatus = feature_request` trên Helpdesk (giá trị đã xác minh qua API ngày 12/10/2026; bộ lọc "Feature" trên Helpdesk) và hiện tiến độ dev/PM của từng yêu cầu do skill `skills/feature-follow` (Hanski) đánh giá từ Slack thread. Người dùng có thể quét lại bằng tay (preview, không đăng), mở panel Follow dev, mở Slack, và nhắc dev khi thread im 48 giờ.

Section chỉ đọc Helpdesk. Comment tiến độ `[FEATURE FOLLOW | …]` và mail nháp `[DRAFT — feature …]` chỉ do timer của skill đăng, và chỉ khi `workflow.json` của skill bật (`enabled: true`) theo rule Hanrul ghi theo lệnh Đại tá; trong lúc xây (12/10/2026) skill để `enabled: false`.

## Cách dùng

1. Mở Tickets. Feature là cột thứ năm trên desktop (lưới 5 cột từ 1024 px) hoặc mục thứ năm trên điện thoại; bấm tiêu đề để mở/đóng.
2. Header section: dòng "Quét tay HH:mm dd-MM" (lượt quét tay gần nhất) hoặc "Timer HH:mm" (lượt timer gần nhất) hoặc "Chưa quét", và nút **Quét** chạy preview cho tất cả ticket Feature. Khi đang quét nút đổi thành "Đang quét…" và trang tự cập nhật mỗi 4 giây.
3. Mỗi hàng: mã + tiêu đề (link mở Slack thread), nút **Follow dev** (panel như Dev fix), **Quét** (preview một ticket), **Mở Slack**, **ⓘ** (web). Dưới hàng là khối tiến độ: nhãn trạng thái (màu theo trạng thái), "chờ: dev/customer", "mail nháp: <loại>" nếu có, đoạn tiến độ ngắn, dòng thời gian (AI đánh giá/quét tay lúc, Slack cập nhật lúc, comment tiến độ lúc), nút **Xem comment** (comment tiến độ mà lượt quét sẽ đăng) và **Xem nháp** (mail nháp) khi có.
4. Khi thread Slack im từ 48 giờ và trạng thái còn chờ dev: hàng hiện "⚠ Cần nhắc dev follow up (N giờ không có update)" và nút **Nhắc dev** giống Dev fix (gửi một tin nhắc vào thread qua bridge); chỉ chạy khi Đại tá bấm.
5. Chưa có đánh giá cho ticket: khối ghi "Chưa quét: chưa có đánh giá từ feature-follow cho ticket này"; chưa cài skill: "Chưa cài skill feature-follow". Web 5088 tắt: extension chỉ thiếu khối tiến độ, danh sách vẫn hiện.

## Nhãn trạng thái (chốt với Hanski 12/10/2026)

`no_response` Dev/PM chưa phản hồi · `acknowledged` Dev/PM đã nhận yêu cầu · `in_progress` Đang phát triển · `awaiting_merge` Chờ review/release · `awaiting_verification` Đã release, chờ kiểm tra · `done` Feature đã release · `awaiting_customer` Chờ khách cung cấp thông tin · `declined` Dev/PM từ chối hoặc chưa làm · `blocked` Đang bị chặn · `unknown` Chưa đủ dữ liệu để kết luận · `missing_thread` Thiếu Slack thread. Nhãn do skill gửi kèm (`statusLabel`) được ưu tiên.

## Luồng từng bước

1. **Danh sách**: như Dev fix. `GROUP_STATUSES` (server `scripts/ts-management-web.mjs`, `chrome-extension/background.js`) có thêm `feature_request`; `loadTicketGroups` đọc `GET /tickets/admin?tsStatus=feature_request&limit=100`, giữ ticket có Andrew. `GROUPS` (`web/app/app.js`, `chrome-extension/widget.js`, `chrome-extension/popup.js`) có mục `{ key: "feature_request", label: "Feature", slackOnly: true, feature: true }` sau Dev fix.
2. **Tiến độ** (`GET /api/feature/follow`, web; extension gửi message `feature-follow` → background `tsWebJson` → cùng route trên 5088):
   - server đọc `runtime/feature-follow/state.json` của skill (shape như `runtime/dev-fix-follow/state.json`: `tickets[<id Helpdesk>] = { reference, assessedAt, postedAt, latestSlackAt, assessment: { status, progress, latestUpdate, latestMeaningfulAt, waitingFor, draftKind, draftMail, confidence } }`, `lastRun`) và kết quả quét tay gần nhất `state.featureFollowScan` trong `runtime/ts-web/state.json`;
   - `featureFollowSummary` (`scripts/feature-section.mjs`) gộp hai nguồn thành một bản tóm tắt mỗi ticket: lượt mới hơn quyết định trạng thái; state timer giữ đoạn tiến độ và mốc Slack; lượt quét tay giữ comment/nháp preview (`scanComment`, `scanDraft`); `reminderDue` = `latestSlackAt` cách hiện tại ≥ 48 giờ và trạng thái không phải done/declined/awaiting_customer; trả `{ tickets (theo id), byReference (theo mã), stateAt, lastSlot, scanAt, scanTicket, scanError, running, runningTicket, skillInstalled }`;
   - trang lưu vào `state.featureFollow`, `createTicket` tra `featureSummaryFor(ticket)` (id trước, mã sau) và vẽ `featureProgressBlock`.
3. **Quét tay** (`POST /api/feature/scan {ticket?}`; extension message `feature-scan`): server kiểm tra `skills/feature-follow/scripts/run.mjs` tồn tại (không thì 503), một lượt một lúc (đang chạy thì 409), rồi chạy nền `node skills/feature-follow/scripts/run.mjs --preview --json [--ticket <mã>]` (cwd gốc dự án, timeout 5 phút), trả 202 ngay với `running: true`. Trang poll `GET /api/feature/follow` mỗi 4 giây và nhận sự kiện SSE `feature-follow-changed`. Khi xong, server parse JSON stdout (`parseScanOutput`: `{ slot, mode, results: [{ id, reference, subject, status, statusLabel, assessed, draft: { kind, action, content? }, progress: { action, changed, reason, content? }, error? }] }`), lưu `featureFollowScan = { at, ticket, results, error, mode }` vào `runtime/ts-web/state.json` và broadcast. Preview không đăng Helpdesk, không gửi Telegram, không ghi state của skill.
4. **Follow dev / Mở Slack / Nhắc dev**: dùng đúng route và message của Dev fix (`/api/dev/follow-detail`, `/api/dev/follow-mail`, `/api/dev/remind`; `get-dev-follow-detail`, `generate-dev-follow-mail`, `send-dev-reminder`), không phụ thuộc tsStatus. Sau Nhắc dev, trang đọc lại `/api/feature/follow` (không chạy quét bridge `/dev-scan` cũ cho Feature).
5. **Timer của skill**: `andrew-feature-follow.timer` (10/14/18/22h) chạy `run.mjs --scheduled`, ghi `runtime/feature-follow/state.json`, log `runtime/feature-follow.log`; section chỉ đọc file này. Preview không ghi state.json (file chỉ xuất hiện sau `--post`/`--scheduled`), nên thiếu file = chưa có lượt timer nào. Thời gian: mỗi ticket cần AI 13–20 giây, hiếm khi tới 180 giây (lỗi `Worker exited unsuccessfully (124)` ở `results[i].error`); server chờ tối đa 4 phút cho một ticket, 20 phút cho lượt tất cả.

## Skill feature-follow (Hanski, 12/10/2026)

Skill `skills/feature-follow/` theo dõi ticket của Andrew có tsStatus `feature_request` (ticket open, Slack thread = slackLink). Code dùng chung với dev-fix-follow (`skills/dev-fix-follow/scripts/{core,service,adapters,cli}.mjs`), chỉ khác profile (`skills/feature-follow/scripts/profile.mjs`: status, nhãn, tiền tố comment, đường dẫn). Mỗi lượt: liệt kê ticket → đọc ticket + comment + Slack thread → AI (codex, read-only) đánh giá khi thread đổi → quyết định mail nháp và comment tiến độ → đăng (chỉ khi --post/--scheduled) → Telegram tóm tắt. Status: no_response, acknowledged, in_progress, awaiting_merge, awaiting_verification, done, awaiting_customer, declined, blocked, unknown, missing_thread. Comment tiến độ `[FEATURE FOLLOW | HH:mm dd/MM/yyyy] <nhãn>`; mail nháp `[DRAFT — feature đã release | Slack update: <ISO>]` (status done) hoặc `[DRAFT — feature chờ khách xác nhận | Slack update: <ISO>]` (awaiting_customer), declined không soạn mail. Chính sách comment on-change-or-daily. State `runtime/feature-follow/state.json`, job `runtime/feature-follow/jobs/<slot>/<ticket>/`, log `runtime/feature-follow.log`, trace source `feature-follow`. Lệnh: `node skills/feature-follow/scripts/run.mjs [--preview|--post|--scheduled] [--ticket <URL|ID>] [--force] [--json]`; npm featfollow:preview/test/install/uninstall; timer `andrew-feature-follow.timer` (10/14/18/22h) cài bằng `scripts/install-feature-follow.mjs`. Hiện `workflow.json` enabled: false và timer chưa cài: chờ Hanrul ghi rule và Đại tá ra lệnh bật. Test: `npm run featfollow:test`.

`--json` in đúng một JSON ra stdout: `{ skill: "feature-follow", slot: {key, date, label, scheduled}, mode, skipped?, notified?, notifyError?, results: [...] }`; lỗi tổng (workflow/lock) → `{ skill, mode, error, results: [] }` và exit 1; `--scheduled` khi enabled=false → `skipped: "disabled"`.

## File và vai trò

- `scripts/feature-section.mjs`: `FEATURE_TS_STATUS`, `FEATURE_STATUS_LABELS`, `featureStatusLabel`, `featureReminderDue`, `featureFollowSummary`, `featureSummaryFor`, `parseScanOutput`, `readFeatureFollowState`. Test: `scripts/feature-section.test.mjs` (`npm run feature:test`).
- `scripts/ts-management-web.mjs`: `GROUP_STATUSES`, `DEFAULT_STATE.featureFollowScan`, `featureFollowPayload`, `runFeatureScan`, `featureTicketReference`, route `GET /feature/follow`, `POST /feature/scan`, SSE `feature-follow-changed`.
- `web/app/app.js`: `GROUPS` (mục Feature), `createCategory` (header Quét), `createTicket` (nút, cảnh báo, Nhắc dev), `featureSummaryFor`, `featureProgressBlock`, `loadFeatureFollow`, `runFeatureScan`; gọi `loadFeatureFollow` lúc boot và khi có SSE. `web/app/style.css`: `.feature-*`, lưới 5 cột.
- `chrome-extension/background.js`: `GROUP_STATUSES`, `tsWebJson`, message `feature-follow`, `feature-scan`. `chrome-extension/widget.js`: cùng các hàm/CSS như web (`.ticket.feature-ticket` xuống dòng cho khối tiến độ), `loadFeatureFollow` lúc mở widget. `chrome-extension/popup.js`, `popup.html`: danh sách chỉ đọc + phụ đề.
- `skills/feature-follow/` (Hanski): skill, state, timer, test `scripts/feature-follow.test.mjs`.

## Dữ liệu lưu

- `runtime/ts-web/state.json` khóa `featureFollowScan` (kết quả quét tay gần nhất, không secret). Không có bảng DB mới.
- `runtime/feature-follow/state.json`, `runtime/feature-follow/jobs/...` do skill ghi; section chỉ đọc.
- Extension không lưu gì thêm (đọc qua 5088).

## Cấu hình và quyền

- `API_AVADA_TICKET` trong `.env_my` (danh sách ticket); skill tự đọc key Helpdesk/Slack của nó. Không dán key.
- Web 5088 phải chạy để extension có tiến độ và nút Quét; `systemctl --user restart andrew-ts-management-web.service` sau khi sửa server. Extension sửa xong cần reload ở `chrome://extensions`.
- Nhắc dev gửi Slack chỉ khi người dùng bấm. Không có quét tự động của web/extension cho Feature (chỉ timer của skill), nên không có hai quét song song.
- Không đổi status, không mark Done, không đăng comment từ section.

## Giới hạn

- Khi Hanski chưa cài skill, nút Quét báo 503 "Skill feature-follow chưa được cài"; khối tiến độ ghi "Chưa cài skill feature-follow".
- Cảnh báo 48 giờ cần `latestSlackAt` từ state timer; ticket chỉ có kết quả quét tay (chưa có state timer) không có mốc Slack nên không cảnh báo.
- Kết quả quét tay chỉ giữ lượt gần nhất; quét một ticket thay thế kết quả của lượt quét tất cả trước đó (trạng thái các ticket khác vẫn còn từ state timer).
- Tiến độ trong popup extension không hiện (popup chỉ liệt kê).

## Cách test

- `npm run feature:test` (gộp tiến độ, cảnh báo 48 giờ, parse JSON).
- `curl -s http://127.0.0.1:5088/api/tickets/groups | jq '.groups.feature_request | length'`; `curl -s http://127.0.0.1:5088/api/feature/follow`.
- `curl -s -X POST http://127.0.0.1:5088/api/feature/scan -H 'content-type: application/json' -d '{"ticket":"CHAT-261011-MyeDrL"}'` → 202 đang chạy (skill đã cài) hoặc 503 (chưa cài); preview không đăng gì.
- Ảnh: Playwright headless với `/api/feature/follow` giả lập (`runtime/screenshots/tickets-feature-desktop.png`, `tickets-feature-phone.png`, `tickets-feature-desktop-scanning.png`, `*-section.png`).

## Thay đổi

- 2026-10-12: Hanbui tạo section Feature (web + extension), module `scripts/feature-section.mjs`, route `/api/feature/follow` và `/api/feature/scan`, cảnh báo 48 giờ + Nhắc dev theo duyệt của Hanlead; skill feature-follow do Hanski làm song song. Hành vi Dev fix không đổi.

## Cập nhật formatter mail ngày 21/10/2026

Mail draft của luồng này truyền appName thật từ ticket vào formatter chung `scripts/customer-mail-format.mjs` qua `formatDraftComment`. Joy Loyalty dùng đúng mở đầu “I am Andrew from the Loyalty technical support team, and I hope this email finds you well” và kết hai dòng “Best regards,” / “Andrew, Joy Technical Support Team”. App khác chỉ dùng tên trong catalog đã xác minh; appName thiếu/lạ thì không đoán đội, không đăng draft. Greeting/signature cũ được thay đúng một lần, giữ subject, nội dung chuyên môn và URL. Không sửa comment đã đăng, không đổi lịch/quyền đăng, không gửi email thật. Các lượt chạy mới nạp formatter khi khởi động; không replay lịch cũ.
