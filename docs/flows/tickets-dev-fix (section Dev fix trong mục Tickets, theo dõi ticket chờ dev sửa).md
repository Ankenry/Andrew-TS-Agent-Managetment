# Tickets · section Dev fix (theo dõi ticket chờ dev sửa)

## Mục đích

Section **Dev fix** trên trang Tickets (extension Chrome và TS Management web 5088) liệt kê ticket của Andrew có `tsStatus = dev_fixing` trên Helpdesk, tức ticket đã báo dev và đang chờ dev sửa. Mỗi hàng mở thẳng Slack thread của ticket, cho xem tình trạng dev qua panel "Follow dev", cảnh báo khi thread im 48 giờ và cho nhắc dev bằng một click. Việc đánh giá tiến độ theo lịch và đăng comment tiến độ do skill `skills/dev-fix-follow` làm (xem "Dev fix follow workflow" trong AGENTS.md); section này chỉ hiển thị và thao tác tay.

## Cách dùng

1. Mở Tickets. Section Dev fix là cột thứ tư (desktop) hoặc mục thứ tư (điện thoại, bấm tiêu đề để mở/đóng); số bên cạnh tên là số ticket.
2. Bấm mã/tiêu đề ticket → mở Slack thread (`slackLink` của ticket). Ticket không có link hiện "`<mã>`: no Slack link".
3. **Follow dev** → panel chi tiết trong trang Chat bot (tab Follow): ticket, phân công, thread Slack, trạng thái Done/Blocked/Chưa done, link Notion/MR, tình trạng báo khách, lần follow cuối; nút Mail tạo mail khách (TS Elite 2) để copy, không đăng.
4. **Mở Slack** mở thread ở tab mới. **ⓘ** (web) mở chi tiết ticket ngay dưới hàng.
5. Khi quét thấy thread im hơn 48 giờ: hàng hiện "⚠ Cần nhắc dev follow up" và nút **Nhắc dev**; bấm thì gửi một tin nhắc vào thread Slack (bridge), rồi quét lại.
6. Notifications > tab "Dev báo done" có nút **Quét ngay** chạy cùng lượt quét bridge này bằng tay.

## Luồng từng bước

1. **Danh sách**: trang gọi `GET /api/tickets/groups` (web) hoặc message `get-ticket-groups` (extension → background). Server/background đọc `GET /tickets/admin?tsStatus=<status>&limit=100` theo từng status trong `GROUP_STATUSES` (`scripts/ts-management-web.mjs`, `chrome-extension/background.js`), giữ ticket có Andrew trong `memberIds`, trả `{ groups: { dev_fixing: [...] } }`. Thứ tự section lấy từ `GROUPS` (`web/app/app.js`, `chrome-extension/widget.js`, `chrome-extension/popup.js`); Dev fix có `slackOnly: true` nên link hàng trỏ sang Slack.
2. **Vẽ hàng**: `createTicket(ticket, group)` (app.js / widget.js) thêm nút Follow dev, Mở Slack (khi có slackLink), ⓘ (web), và khi `state.devFollowDue[<mã>]` có giá trị thì thêm cảnh báo + Nhắc dev.
3. **Quét cảnh báo 48 giờ** (`followDevFixTickets`): web chạy khi mở trang (`boot()` app.js) và khi bấm Nhắc dev/Quét ngay; extension chỉ chạy sau Nhắc dev hoặc Quét ngay. Server/background lấy ticket dev_fixing rồi `POST http://127.0.0.1:39542/dev-scan` tới bridge `scripts/codex-ticket-bridge.mjs` (`scanDevFixTickets`): bridge đọc thread bằng Slack `conversations.replies` (token `SLACK_TOKEN` trong `.env_my`), phân loại bằng regex (`classifyDevFollow`), `followUpDue` = không có update Slack 48 giờ. Kết quả `due` đổ vào `state.devFollowDue`. Lượt quét bridge còn có thể lưu mail nháp (dev báo done / chờ khách xác nhận) qua `/dev-ticket-write` và tick Done theo quy tắc cũ; phần này là hành vi sẵn có của bridge, không phải của section.
4. **Follow dev**: `POST /api/dev/follow-detail` (message `get-dev-follow-detail`) → server đọc ticket + comment trên Helpdesk và thread qua bridge `/dev-ticket-detail`; `POST /api/dev/follow-mail` (message `generate-dev-follow-mail`) tạo mail bằng TS Elite 2, chỉ hiển thị để copy.
5. **Nhắc dev**: `POST /api/dev/remind` (message `send-dev-reminder`) → bridge `/dev-remind` gửi `chat.postMessage` vào thread. Chỉ chạy khi người dùng bấm.
6. **Lịch**: không có quét tự động của web/extension cho Dev fix nữa (alarm `dev-fix-hourly-scan` chỉ còn được xóa). Giờ chạy kế tiếp hiển thị ở Settings/Notifications lấy từ `DEV_FIX_FOLLOW_HOURS` (10/14/18/22) của timer `andrew-dev-fix-follow.timer`.

## File và vai trò

- `web/app/app.js`: `GROUPS`, `createCategory`, `createTicket`, `followDevFixTickets`, `openFollowDev`/`renderFollowDev`; `web/app/style.css` (`.category`, `.ticket`, `.dev-reminder-warning`, lưới 5 cột desktop).
- `chrome-extension/widget.js`: cùng các hàm cho widget (CSS inline trong file); `chrome-extension/popup.js` + `popup.html`: danh sách chỉ đọc trong popup.
- `scripts/ts-management-web.mjs`: `GROUP_STATUSES`, `loadTicketGroups`, `followDevFixTickets`, `sendManualDevReminder`, `loadDevFollowDetail`, `generateDevFollowMail`, route `/api/tickets/groups`, `/api/dev/follow-scan|remind|follow-detail|follow-mail`, `/api/scans/run {key:"dev_follow"}`.
- `chrome-extension/background.js`: `GROUP_STATUSES`, `loadTicketGroups`, `followDevFixTickets`, message `get-ticket-groups`, `follow-dev-fixing`, `send-dev-reminder`, `get-dev-follow-detail`, `generate-dev-follow-mail`.
- `scripts/codex-ticket-bridge.mjs`: `/dev-scan`, `/dev-ticket-detail`, `/dev-remind`, `/dev-ticket-write` (đọc Slack, phân loại regex, gửi nhắc).
- `skills/dev-fix-follow/`: skill theo dõi theo lịch (đánh giá bằng AI, đăng `[DEV FOLLOW | …]`, mail nháp `[DRAFT — …]`); state `runtime/dev-fix-follow/state.json`.

## Dữ liệu lưu

- Web: `runtime/ts-web/state.json` khóa `devFollowScanState`, `devDoneNotifications`, `devCustomerDraftState`, `devDoneDraftState`. Extension: `chrome.storage.local` cùng tên khóa.
- `state.devFollowDue` chỉ trong bộ nhớ trang.

## Cấu hình và quyền

- `API_AVADA_TICKET` (Helpdesk) và `SLACK_TOKEN` (bridge) trong `.env_my`; không dán ra ngoài.
- Bridge 39542 do native host khởi động (Settings > Start dịch vụ local).
- Nhắc dev gửi tin lên Slack: chỉ khi người dùng bấm. Không đổi status, không mark Done từ section này (tick Done nằm trong luồng bridge/skill đã được Đại tá ủy quyền riêng).

## Giới hạn

- Hàng không hiện tiến độ AI; tiến độ chỉ có ở comment `[DEV FOLLOW | …]` trên Helpdesk do skill đăng.
- Cảnh báo 48 giờ dựa trên regex của bridge, không phải đánh giá AI của skill.
- Không có test tự động cho phần giao diện; `npm run devfollow:test` chỉ test skill.

## Cách test

- Mở `http://andrewtsmanagement.com:5088` → Tickets, xem cột Dev fix; `curl -s http://127.0.0.1:5088/api/tickets/groups | jq '.groups.dev_fixing | length'`.
- `curl -s -X POST http://127.0.0.1:5088/api/dev/follow-scan -H 'content-type: application/json' -d '{}'` (cần bridge chạy) → `due`.
- Playwright headless (chụp `runtime/screenshots/`), không mở Chrome thật.

## Thay đổi

- 2026-10-12: Hanbui viết flow doc này (section tồn tại từ trước nhưng chưa có tài liệu) khi thêm section Feature ngay dưới; lưới desktop đổi từ 4 sang 5 cột. Hành vi Dev fix không đổi.

## Cập nhật formatter mail ngày 21/10/2026

Mail draft của luồng này truyền appName thật từ ticket vào formatter chung `scripts/customer-mail-format.mjs` qua `formatDraftComment`. Joy Loyalty dùng đúng mở đầu “I am Andrew from the Loyalty technical support team, and I hope this email finds you well” và kết hai dòng “Best regards,” / “Andrew, Joy Technical Support Team”. App khác chỉ dùng tên trong catalog đã xác minh; appName thiếu/lạ thì không đoán đội, không đăng draft. Greeting/signature cũ được thay đúng một lần, giữ subject, nội dung chuyên môn và URL. Không sửa comment đã đăng, không đổi lịch/quyền đăng, không gửi email thật. Các lượt chạy mới nạp formatter khi khởi động; không replay lịch cũ.
