# TS Management web (LAN)

Web local có đầy đủ chức năng của extension Chrome **TS Management**, chạy trên
máy này và cho thiết bị khác cùng mạng truy cập (điện thoại, laptop). Khi có
domain thật chỉ cần đặt reverse proxy/HTTPS trỏ về cổng này.

- Server: `scripts/ts-management-web.mjs` (Node 20, không cần dependency).
- Giao diện: `web/app/` (`index.html`, `app.js`, `style.css`, `manifest.webmanifest`),
  responsive: mobile-first (iPhone 14 Pro Max 430×932, safe-area, thanh điều hướng dưới) và layout desktop riêng từ 1024px (sidebar trái, bảng ticket 4 cột kanban, chat rộng, notifications/settings dạng lưới).
- Mặc định lắng nghe `0.0.0.0:5088`. Đổi bằng `TS_WEB_PORT`, `TS_WEB_HOST` trong
  `.env_my` hoặc `--port`, `--host`.
- Tùy chọn `TS_WEB_PIN=<mã>` trong `.env_my` để yêu cầu mã truy cập trước khi dùng
  API (nên bật nếu mạng LAN có người lạ, vì web có quyền đổi trạng thái ticket).

## Link cố định từ mọi mạng (Tailscale): `http://andrewtsmanagement.tail05e88b.ts.net:5088`

Máy này đã cài Tailscale (apt, `tailscaled` tự chạy khi mở máy), tên máy `andrewtsmanagement`,
đăng nhập tài khoản `annvh@avadagroup.com`, `--accept-dns=false` (không đổi DNS của máy).
iPhone bật app Tailscale cùng tài khoản là mở được link, kể cả khi dùng Wi-Fi khác hoặc 4G.

- Tailnet này là tailnet chung của công ty. Server chỉ chấp nhận request đến từ địa chỉ Tailscale
  (100.64.0.0/10) nếu thiết bị thuộc login sở hữu máy này (tra bằng `tailscale whois`). Thiết bị
  của tài khoản khác nhận 403.
- Cho thêm người: `TS_WEB_TAILNET_USERS=a@avadagroup.com,b@avadagroup.com` trong `.env_my`;
  cho cả tailnet: `TS_WEB_TAILNET_USERS=*` (nên đặt kèm `TS_WEB_PIN`).
- Quy tắc này chỉ áp dụng cho cổng 5088. Cổng khác mở trên `0.0.0.0` (ví dụ tracing web 5077)
  vẫn truy cập được từ tailnet theo ACL của công ty.

## Link cố định cho mọi thiết bị: `http://andrewtsmanagement.local:5088`

Server tự quảng bá tên `andrewtsmanagement.local` bằng mDNS (`scripts/ts-web-mdns.mjs`, UDP 5353,
không cần root, chạy chung với avahi). Tên này luôn trỏ về IP LAN hiện tại của máy, nên link
không đổi khi đổi Wi-Fi hoặc router cấp IP mới. iPhone, Mac, Android 12+, Windows 10+ hiểu sẵn `.local`.

- Đổi tên: `TS_WEB_MDNS_NAME=<tên>.local` trong `.env_my`; tắt: `TS_WEB_MDNS_NAME=off`.
- Không hoạt động nếu Wi-Fi bật AP/client isolation hoặc chặn multicast (hay gặp ở Wi-Fi khách, quán cà phê).
  Khi đó dùng link IP trong Settings.

## Tên miền local

Trên máy này web mở bằng `http://andrewtsmanagement.com:5088`. Đây là tên local, không
phải domain đã đăng ký:

```bash
echo "127.0.0.1 andrewtsmanagement.com" | sudo tee -a /etc/hosts   # chạy một lần
```

- `TS_WEB_PUBLIC_URL=http://andrewtsmanagement.com:5088` trong `.env_my` để Settings và log hiển thị link này.
- Thiết bị khác (iPhone…) không có bản ghi hosts nên vẫn dùng `http://<IP LAN>:5088`.
- Muốn bỏ `:5088` cần cho phép cổng 80 (`net.ipv4.ip_unprivileged_port_start=80`) rồi đặt `TS_WEB_PORT=80`.

## Chạy

```bash
npm run web:start                 # chạy foreground
npm run web:install               # cài systemd --user: tự chạy khi đăng nhập, tự restart
npm run web:uninstall
systemctl --user status andrew-ts-management-web.service
tail -f runtime/ts-management-web.log
```

Muốn web chạy ngay khi máy khởi động mà chưa đăng nhập: `loginctl enable-linger $USER`.

Link chia sẻ hiển thị trong **Settings → Chia sẻ web trong mạng LAN** (ví dụ
`http://<IP LAN hiện tại>:5088`; IP đổi theo mạng Wi-Fi nên luôn xem link mới nhất ở đây hoặc trong `runtime/ts-management-web.log`). Trên iPhone: Safari → Chia sẻ → *Thêm vào Màn hình chính*.

## Chức năng (tương đương extension)

| Màn hình | Nội dung |
| --- | --- |
| Tickets | Pending / Doing / Wait customer / Dev fix / Feature (ticket `feature_request`, tiến độ từ skill feature-follow, nút Quét preview, cảnh báo 48 giờ + Nhắc dev; flow doc `docs/flows/tickets-feature (…).md`) của Andrew; Move to doing, Wait customer, Move to done, chọn nhiều + Move N, Keep Andrew, Check (chat AI), Follow dev, Mở Slack, cảnh báo *Cần nhắc dev follow up* + Nhắc dev; nút ⓘ xem chi tiết (thay tooltip hover); Ticket Management theo TS1/TS2. |
| Chat bot | Provider TS Elite 2 / Hachimi local / Hachimi + TS Elite 2, stream câu trả lời, context ticket, History (lưu trên server, dùng chung mọi thiết bị; gồm cả các lượt check ticket tự động, nhãn **Auto check**), Tracing, tab Follow dev (Ticket / Thread / Mail). |
| Checking | Trang riêng trên navigation, giữa Chat bot và Notifications: danh sách các lượt Hachimi check ticket, từng bước của mỗi lượt (tự cập nhật khi đang chạy) và ô hỏi thêm Hachimi về ticket đó. |
| DFY Accessibility | Ticket Done For You của Andrew chưa tick Done trên Helpdesk (trường `dueDateDone`; nút **Run**), khối nộp report `.md` của Accessibility scanner (chọn file / kéo thả; khóa tới khi Run, ticket đã có report thì phải chọn Thay thế), khối thông tin report + AI phân tích Issue Details theo checklist DFY + bài học sửa lỗi (`knowledge-base/app-guides/accessibility-dfy-*.md`); mọi phiên bản lưu Postgres `hachimi`. |
| Notifications | Thông báo chung (Helpdesk), Dev báo done, Date Follow, Skill SLA; Unread only / Read all (trạng thái đọc dùng chung); nút *Quét ngay*; Move to wait customer từ báo cáo dev. |
| Settings | Helpdesk API key, Dark mode, Giữ màn hình luôn bật (Screen Wake Lock, cần HTTPS/localhost), Tự kết nối dịch vụ local, Quét tự động, AI provider + kết nối TS Elite 2 (dán token), trạng thái/khởi động dịch vụ local, link LAN. |

Realtime: server nối tới webhook bridge `127.0.0.1:39543/events` và phát lại cho
trình duyệt qua `/api/events` (SSE); ngoài ra có đối soát 30 phút.

History tự nhận các lượt check ticket tự động mỗi lần mở (`GET /api/chats`): server đọc
`runtime/check-ticket/state.json` qua `skills/check-ticket/scripts/history.mjs` (chỉ đọc, 10 ngày gần nhất,
tối đa 30 lượt, tính riêng với 30 conversation thủ công). Xóa một lượt tự động thì lượt đó không được thêm lại.

Trang **Checking** đọc các lượt check (nguồn `automatic` và `manual`) từ tracing web local qua
`GET /api/checking/sessions` và `GET /api/checking/sessions/<id>/events?after=<seq>` (chỉ đọc; cần Hachimi
tracing web đang chạy). Danh sách tự làm mới 5 giây, lượt đang chạy 2,5 giây. Ô chat bên dưới dùng chat bot
sẵn có với ticket của lượt đó; lượt tự động dùng chung conversation `auto-<id ticket>` với History. Hỏi ở đây
không chạy lại lượt check và không đăng comment. View dùng chung với extension: `chrome-extension/checking-ticket.js`.

Nút **Tracing** mở địa chỉ trace web mà thiết bị đang dùng vào được: trên máy này là
`http://andrewtstracing.localhost:5077`, trên điện thoại là `http://andrewtstracing.local:5077` hoặc `http://<IP LAN>:5077`
(xem chỉ-đọc, chi tiết trong `scripts/hachimi-trace-web.README.md`).

## Khác biệt so với extension

- **Lưu trữ**: thay `chrome.storage` bằng `runtime/ts-web/settings.json` (API key,
  token, provider; mode 600) và `runtime/ts-web/state.json` (thông báo tự động,
  trạng thái quét, lịch sử chat, đã đọc). Key/token trống thì dùng
  `API_AVADA_TICKET` và `TS_ELITE_EXT_TOKEN` trong `.env_my`.
- **Đăng nhập TS Elite 2**: web không bắt được URL của tab khác. Bấm *Kết nối TS
  Elite 2*, đăng nhập ở tab mở ra, rồi dán URL `…/ext-login-done#<token>` (hoặc
  token) vào ô trong Settings.
- **Dịch vụ local**: server gọi đúng `scripts/telegram-notifier-native-host.mjs`
  qua stdin/stdout (cùng logic với extension) để start/status Telegram bot,
  Hachimi bridge, webhook bridge, database, tracing web.
- **Quét tự động** (Dev Fix mỗi giờ, Date Follow 5 phút, Skill SLA 2 giờ) chạy trên
  server web khi bật **Quét tự động** trong Settings. Mặc định lần cài đầu để
  **tắt** vì extension Chrome đang chạy các quét này; hai bên chạy song song sẽ
  lưu trùng mail nháp vào comment ticket. Chỉ bật một bên.
- Trả lời AI cho Telegram (`/telegram-ai-bridge`) luôn được server web nhận nếu
  extension không nhận trước; job chỉ được cấp một lần nên không trùng.
- **Ticket Management** dùng bảng app → TS1/TS2 (như background của extension), không
  đọc được `group` nội bộ như widget trong trang Helpdesk.
- **Giữ màn hình luôn bật** chỉ hoạt động trên HTTPS/localhost (giới hạn trình duyệt).

## API

`GET /api/health`, `GET /api/bootstrap`, `GET /api/events` (SSE),
`GET /api/tickets/groups`, `POST /api/tickets/move|move-all|keep-andrew|keep-andrew-ticket`,
`GET /api/ticket-management?team=TS2`, `GET /api/notifications`,
`POST /api/notifications/read`, `POST /api/dev/follow-scan|remind|follow-detail|follow-mail`, `GET /api/feature/follow` + `POST /api/feature/scan {ticket?}` (section Feature: tiến độ từ `runtime/feature-follow/state.json` + quét preview `skills/feature-follow/scripts/run.mjs --preview --json`, chạy nền, không đăng),
`POST /api/scans/run`, `POST /api/ai/chat`, `GET /api/ai/stream/:jobId` (SSE),
`GET/POST /api/ai/status|provider|token`, `GET/PUT/DELETE /api/chats`,
`GET /api/services/status`, `POST /api/services/<action>`, `POST /api/settings`,
`GET/POST /api/dfu/*` (DFY Accessibility, xem mục dưới).
Mọi request (trừ health) cần header `X-TS-Web-Key` hoặc `?key=` khi đặt `TS_WEB_PIN`.

## Analytics

Trang **Analytics** (navigation) hiển thị tỉ lệ AI check ticket đúng theo reaction của Đại tá trên các comment báo cáo (👍 đúng, 😢 chưa đúng), biểu đồ tròn + cột (7 ngày / 30 ngày / tùy chọn), danh sách ticket đúng/chưa đúng và khối feedback **Train AI**. Server proxy `/api/analytics/*` tới tracing web (5077) và phục vụ `/analytics-view.js` từ `chrome-extension/analytics-view.js` (cùng file với extension). Chi tiết: `scripts/hachimi-trace-web.README.md`.

## DFY Accessibility

Trang **DFY Accessibility** (navigation, giữa Analytics và Notifications; tên hiển thị đổi từ DFU sang DFY ngày 11/10/2026, tên nội bộ `dfu` giữ nguyên trong route `/api/dfu/*`, file `web/app/dfu-accessibility.js`, `scripts/dfu-accessibility-*.mjs`, bảng `dfu_accessibility_*`, biến `DFU_RETENTION_DAYS`) phục vụ ticket Done For You của app SEA Accessibility: danh sách ticket `[DFY]`/tsStatus `done_for_you` của Andrew chưa tick Done (`dueDateDone`, dù ở status nào; Helpdesk chỉ đọc, cache 60 giây) với nút **Run**; khối **Report accessibility scan** nhận file `.md` của scanner (chọn từ thiết bị hoặc kéo thả) chỉ sau khi Run, ticket đã có report thì hiện report đã lưu và cần bấm **Thay thế bằng file mới** (phiên bản tăng, bản cũ giữ trong lịch sử); khối **Thông tin report** hiện điểm/risk/breakdown, bảng issue theo mã WCAG và phần Issue Details do AI (Codex local — unit systemd đặt `Environment=PATH=%h/.local/bin:…` và `resolveCodexBin` tìm đường dẫn tuyệt đối để service chạy từ boot vẫn thấy lệnh `codex`; knowledge = `knowledge-base/app-guides/accessibility-dfy-checklist.md` + `accessibility-dfy-fix-lessons.md`, bản gốc `DFU_Accessibility/Accessibility_rule_DFU.md` là dự phòng) tóm tắt, phân tích false positive / lỗi thật, việc cần làm, ai làm; nút **Phân tích lại**, **Xem file md**, **Lịch sử phiên bản**.

Dữ liệu DFU tự xóa sau 60 ngày kể từ lần nộp report đầu của ticket (`min(uploaded_at)`; thay report không làm mới mốc): web dọn lúc khởi động và mỗi 24 giờ, ghi log `[ts-web] dfu purge …`, hạn đặt bằng `DFU_RETENTION_DAYS` trong `.env_my` (mặc định 60). Đây là thao tác xóa duy nhất của mục này.

**Start check** (11/10/2026): mỗi dòng lỗi trong bảng Accessibility issues có ô **URL ảnh mô phỏng lỗi** và nút **Start check**. Bấm → server thu bằng chứng trên store bằng Playwright headless (tối đa 4 trang bị lỗi + 1 trang đối chứng: outline heading, element khớp, computed style, id section Shopify), tra rule của scanner qua Source Code API (`scripts/source-api.mjs`, best effort), gọi Codex **viết thẳng thân comment** ngắn gọn ba phần (Lỗi / Page bị lỗi / Cách khắc phục với file/dòng hoặc Pages content / Customize theme và code trước → sau ngắn; code trong fence ``` vì Helpdesk render Markdown; mục tiêu 2.000–3.000 ký tự) rồi **đăng comment lên ticket** như Andrew (`scripts/helpdesk-comment-author.mjs`) theo mẫu của Đại tá: dòng `Lỗi mã <wcag> - "…"` + thân AI + link ảnh một dòng riêng + `TS sẽ thực hiện …`. Trạng thái/kết quả/id comment lưu bảng `dfu_accessibility_checks` (`scripts/dfu-accessibility-check.mjs`; xóa cùng report). Issue đã đăng thì nút thành **Check lại** và hỏi xác nhận trước khi đăng thêm. Cả tải danh sách ticket (`GET /api/dfu/tickets/progress`, % theo trang Helpdesk đã đọc) lẫn lượt Start check (cột `progress`/`step`, 5 bước) hiện thanh tiến độ % thật (11/10/2026). Không đổi status, không tick Done, không mark solved. API: `GET/POST /api/dfu/report/<id>/checks`, `GET /api/dfu/check/<id>` (`dryRun: true` để lấy nội dung mà không đăng).

- Dữ liệu: bảng `dfu_accessibility_reports` trong Postgres `hachimi` (`npm run db:migrate` sau khi cập nhật schema); logic `scripts/dfu-accessibility-store.mjs`; giao diện `web/app/dfu-accessibility.js`.
- API: `GET /api/dfu/tickets[?refresh=1]`, `GET /api/dfu/reports/<ticket id>[?content=1]`, `GET /api/dfu/reports/<ticket id>/versions`, `GET /api/dfu/report/<id>[?content=1]`, `POST /api/dfu/reports/<ticket id>` `{ filename, content, replace? }` (409 khi đã có report mà không `replace`), `POST /api/dfu/report/<id>/analyze`.
- Không đăng comment, không đổi status, không mark done. Test: `npm run dfu:test`. Luồng: `docs/flows/dfu-accessibility (ticket Done For You, nộp report accessibility scan và AI phân tích issue).md`.

## Đọc thành tiếng trong chat bot

Trong Chat bot (web và extension) gõ:

- `đọc <số>` (hoặc `đọc báo cáo số <số>`): hiện báo cáo số đó của Hanlead (`runtime/hanlead-reports/<n>.md`) và đọc thành tiếng trên thiết bị đang mở.
- `đọc`: đọc câu trả lời gần nhất của chat bot. Mỗi câu trả lời cũng có nút **🔊 Đọc**.
- `dừng` (hoặc bấm **⏹ Dừng đọc**): dừng.

Các lệnh này không gọi AI. Server làm sạch văn bản thành văn nói (`scripts/hanlead-speech.mjs`: bỏ markdown, bảng, mã, đường dẫn; đổi tên riêng/từ tiếng Anh sang cách đọc), cắt thành đoạn ngắn và tạo tiếng từng đoạn bằng Piper offline (cùng giọng và tham số với `scripts/hanlead-report.mjs say`); báo cáo đã có `<n>.speech.txt` thì dùng nguyên văn đó. File tiếng được giữ ở `runtime/speech-cache/<id>/`. Không có Piper thì trình duyệt đọc bằng giọng có sẵn của nó.

- `POST /api/speech/prepare` `{ report: <số> }` hoặc `{ text }` → `{ id, segments[], display, voice }`
- `GET /api/speech/audio/<id>/<index>` → `audio/wav`

Extension gọi hai endpoint này từ loopback (không cần mã truy cập); thiết bị LAN dùng như các API khác của web. Test: `npm run speech:test`.

## NEWS

Nút **NEWS** trên trang Tickets (bên trái pill Live) mở bản tin hằng ngày: Claude · Model AI mới · Công nghệ, mỗi tin có tóm tắt tiếng Việt. Dưới ba nhóm tin là ba mục mỗi ngày **10 mẹo dùng AI**, **10 tính năng hay của Claude và Codex** và **10 tool/extension hay dùng với AI** (từ 13/10/2026; `scripts/news-tips.mjs`, Codex viết một lần/ngày, lịch sử chống lặp 60 ngày `runtime/ts-web/news/tips-history.json`, trường `tips` trong file bản tin; link tool được server kiểm HEAD/GET thật, link chết gắn "chưa kiểm được link"; "Làm mới" tạo lại cả ba mục). Server tạo bản tin lúc 08:00 hoặc khi có yêu cầu đầu tiên trong ngày (`scripts/news-store.mjs`, nguồn trong `scripts/news-sources.json`, tóm tắt bằng Codex local), lưu `runtime/ts-web/news/<ngày>.json`. API: `GET /api/news/today[?meta=1]`, `GET /api/news/dates`, `GET /api/news/<ngày>`, `POST /api/news/refresh` (chỉ loopback). Test: `npm run news:test`; tải thật: `npm run news:build`. Luồng: `docs/flows/news (tin tức công nghệ, model AI và Claude hằng ngày).md`.

