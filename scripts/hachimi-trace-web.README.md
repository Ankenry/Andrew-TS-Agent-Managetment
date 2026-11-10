# Hachimi Trace — web local quản lý tracing check ticket

Web chạy tại `http://andrewtstracing.localhost:5077` (= `http://127.0.0.1:5077`; thiết bị khác cùng mạng xem chỉ-đọc qua `http://andrewtstracing.local:5077`), hiển thị realtime quá trình Hachimi
check ticket: các pha xử lý, suy luận (`thinking`), tool đã dùng, kết quả, lỗi, cùng artifact
của từng lượt. Dữ liệu nằm trong Postgres `hachimi` (`db/docker-compose.yml`) và **tự xóa sau
10 ngày** kể từ lúc phiên bắt đầu.

## Chạy

```bash
npm run db:up             # Postgres hachimi (nếu chưa chạy)
npm run db:migrate        # áp schema (thêm cột expires_at, bảng trace_retention_runs)
npm run trace:web         # chạy foreground, Ctrl+C để dừng
npm run trace:web:install # cài user systemd service andrew-hachimi-trace-web.service (tự chạy khi đăng nhập)
```

Xem log service: `journalctl --user -u andrew-hachimi-trace-web.service -n 50`.

**Tự chạy theo extension**: mỗi khi extension TS Management khởi động (Chrome mở, extension
cài/reload, hoặc bật lại "Tự kết nối" trong Settings), background gửi action `trace-web-start`
tới native host `scripts/telegram-notifier-native-host.mjs`. Native host kiểm tra
`/api/health`; nếu server chưa chạy thì `systemctl --user start andrew-hachimi-trace-web.service`
(khi đã cài unit), còn không thì mở screen session `andrew_hachimi_trace_web` với log
`runtime/hachimi-trace-web.log`. Server đang chạy thì để yên.
Gỡ service: `node scripts/install-hachimi-trace-web.mjs --uninstall`.

Biến môi trường (env hoặc `.env_my`): `HACHIMI_TRACE_WEB_PORT` (mặc định 5077),
`HACHIMI_TRACE_RETENTION_DAYS` (mặc định 10), `HACHIMI_DATABASE_URL`.

## Địa chỉ web: `http://andrewtstracing.localhost:5077`

Đây là địa chỉ dùng trên máy này (link trong extension, TS Management web, tài liệu). Trình duyệt tự trỏ mọi tên
`*.localhost` về chính máy đang mở nên không cần sửa `/etc/hosts`, không cần sudo.
`http://127.0.0.1:5077` vẫn vào được và là địa chỉ các script nội bộ dùng.

- Server chỉ nhận header `Host` là loopback, `*.localhost`, IP LAN của chính máy này hoặc tên mDNS của máy
  (chặn DNS rebinding); host khác nhận 421.
- `*.localhost` là secure context nên Chrome không hiện cảnh báo "Không bảo mật".
- Tùy chọn: muốn tên miền không kèm cổng (vd `http://andrewtstracing.com`) thì chạy
  `sudo bash scripts/install-hachimi-trace-domain.sh` rồi đặt `HACHIMI_TRACE_WEB_DOMAIN=andrewtstracing.com`
  trong `.env_my`. Link của extension vẫn dùng `andrewtstracing.localhost:5077`.
- `node scripts/hachimi-trace-domain.mjs` (`npm run trace:domain`) in ra địa chỉ đang dùng.

## Xem từ điện thoại / thiết bị khác cùng mạng

Tên `*.localhost` trên điện thoại trỏ về chính điện thoại, nên thiết bị khác dùng địa chỉ riêng:

- `http://andrewtstracing.local:5077`: tên cố định qua mDNS (iPhone, Mac, Android mới, Windows), tự theo IP của máy.
- `http://<IP LAN>:5077` (vd `http://192.168.1.8:5077`): dùng khi thiết bị không hỗ trợ mDNS.
- Nút **Tracing** trong TS Management web tự chọn địa chỉ theo thiết bị đang mở: máy này nhận
  `andrewtstracing.localhost`, thiết bị vào bằng tên `.local` nhận `andrewtstracing.local`, thiết bị vào bằng IP nhận IP.

Thiết bị khác chỉ được xem: mọi request không phải `GET` từ địa chỉ ngoài loopback nhận 403, và giao diện ẩn các nút
*Đồng bộ file*, *Dọn hết hạn*, *Xóa phiên*. Ghi trace, xóa và dọn chỉ làm được trên máy này.

Giao diện điện thoại (màn hình rộng tới 760px, hoặc điện thoại xoay ngang; chuẩn kiểm tra là iPhone 14 Pro Max 430×932):

- Hai màn hình thay cho hai cột: danh sách phiên, rồi một phiên. Nút **‹ Danh sách** và thao tác vuốt quay lại của
  trình duyệt đều đưa về danh sách ở đúng vị trí đang xem.
- Cả trang cuộn tự nhiên, không còn vùng cuộn lồng nhau; thanh tiêu đề phiên và hàng tab dính ở đầu màn hình.
- Thống kê, tab và bộ lọc là các hàng vuốt ngang; ô nhập 16px (iOS không tự phóng to), nút bấm cao tối thiểu 44px,
  chừa vùng an toàn của tai thỏ và thanh home.
- Trang xem nguồn hiện tài liệu trước; các thẻ *Nguồn*, *Mốc timeline*, *Mục lục* gập lại, bấm để mở.
- Quy tắc nằm cuối `web/trace/style.css` (mục "phone layout"); điều kiện màn hình phải giống hằng `PHONE` trong
  `web/trace/app.js` và `web/trace/source.js`. Giao diện màn hình rộng không đổi.

| Biến `.env_my` | Ý nghĩa |
| --- | --- |
| `HACHIMI_TRACE_WEB_LAN=off` | Tắt truy cập LAN, server chỉ bind `127.0.0.1` như trước. |
| `HACHIMI_TRACE_WEB_MDNS_NAME` | Đổi tên mDNS (mặc định `andrewtstracing.local`), `off` để tắt. |
| `TS_WEB_PIN` | Nếu TS Management web đặt mã truy cập thì thiết bị LAN cũng phải có mã đó mới xem được trace; nút Tracing của web tự gửi kèm. |

## Trace đi vào web bằng cách nào

1. **Controller check-ticket tự động** (`skills/check-ticket/scripts/adapters.mjs`): mỗi pha
   (`elite`, `classify`, `customize`, `bug-browser`, `demo`…) gửi một event `phase` qua HTTP;
   worker có thể gọi `io.trace(kind, text, { phase, payload })` để ghi thêm. Gửi best-effort,
   không ảnh hưởng review. Chi tiết các mốc ở mục "Nhật ký của một lượt check tự động" bên dưới.
2. **Đồng bộ file** (30 giây/lần trong server, hoặc nút "Đồng bộ file"): đọc
   `runtime/check-ticket/state.json`, `widget-chat.jsonl`, `chat-relay-state.json` và artifact
   trong `runtime/check-ticket/jobs/<job>/<run>/` (elite.txt, classify-result.json, comment.txt…).
3. **Hachimi check thủ công** (Codex/Claude): gửi từng mốc suy luận bằng CLI:

```bash
node scripts/hachimi-trace-client.mjs --source manual --id <trace-id> \
  --ticket JOY-260925-xxxx --subject "Tiêu đề" --category Bug \
  --kind thinking --phase classify --text "Đang phân loại: có storefront impact"
node scripts/hachimi-trace-client.mjs --source manual --id <trace-id> --kind done --text "Đã có draft"
```

`--id` là mã phiên (vd `manual-JOY-260925-xxxx-<hhmm>`); cùng id thì các event nối tiếp nhau.
Nếu web chưa chạy, client tự ghi thẳng vào DB (`via: db`); `--no-fallback` tắt hành vi này.

## Nhật ký của một lượt check tự động

Mỗi lần thử của một job để lại các mốc sau trên timeline (theo đúng thứ tự phát sinh, giờ là giờ
phát sinh chứ không phải giờ web nhận):

| Mốc | Loại | Nội dung |
|---|---|---|
| Bắt đầu lần thử | `start` | `Lần thử n/max`, `runId`, trigger |
| Thông báo Telegram | `note` / `warning` | đã gửi `received`/`checking`/`completed`/`failed`, hoặc lý do chưa gửi được và thời gian thử lại |
| Bắt đầu pha | `phase` | tên pha |
| Gọi bridge | `tool` rồi `note` | yêu cầu đã gửi; khi có trả lời ghi **bên xử lý** (`extension` hay `ts-web`), HTTP status, thời gian chờ |
| Kết thúc pha | `note` | `Hoàn tất pha … sau …s` |
| Pha lỗi / quá hạn | `warning` | lý do gốc (vd `AI_LOGIN_REQUIRED (HTTP 400)`), thời gian đã chạy, bên xử lý, gợi ý nguyên nhân |
| Dùng kết quả dự phòng | `warning` | pha nào, vì `timeout` hay kết quả không dùng được |
| Soạn xong báo cáo | `observation` | category, độ dài, `audit` thời lượng từng pha |
| Đăng comment | `tool` | lần gửi thứ mấy; chưa xác nhận được thì thêm `warning` |
| Lần thử thất bại | `warning` | `Lần thử n/max dừng ở pha …: <lý do> → thử lại sau …s` hoặc `đã hết lượt thử` |
| Controller khởi động lại giữa chừng | `warning` | pha đang chạy lúc bị ngắt, job được xếp lại hay hết lượt |
| Kết thúc | `result` + `done`, `error`, `cancelled` | do đồng bộ file ghi từ `state.json`, kèm pha dừng và số lần thử |

- `warning` là sự cố mà lượt check vẫn đi tiếp; chỉ `done/error/cancelled` mới đóng phiên. Một lần thử
  hỏng còn được thử lại nên không bao giờ ghi bằng `error`.
- Timeline hiện sẵn các số liệu chính của `payload` (lần thử, thời lượng, bên xử lý, HTTP, mã lỗi)
  ngay dưới nội dung; phần còn lại nằm trong mục `payload`.
- Mọi mốc cũng được ghi vào `runtime/check-ticket/jobs/<job>/trace.jsonl` (mỗi dòng một event, có
  `runId` và `delivered`). Dòng `delivered:false` là mốc chưa tới được web (web tắt hoặc quá 3 giây);
  lần đồng bộ file kế tiếp sẽ đưa vào DB đúng một lần (con trỏ `metadata.synced.undelivered`).
- Web từ chối một lô event (sai `kind`, quá lớn…) thì ghi một dòng `[trace-web] rejected …` vào journal:
  `journalctl --user -u andrew-hachimi-trace-web.service`.
- Chỉ thư mục dưới `runtime/check-ticket/` mới được trace; thư mục tạm (test) không gửi gì.

## Nguồn dữ liệu AI đã lấy (tab "Nguồn dữ liệu")

Mỗi event trên timeline có thể mang danh sách **nguồn** (`sources`) — dữ liệu AI đã lấy ở bước đó.
Web hiển thị chúng theo hai cách: chip nhỏ ngay dưới event trong Timeline, và tab **Nguồn dữ liệu**
gom theo từng mốc timeline (lọc theo loại). Bấm vào một nguồn sẽ mở **cửa sổ mới**
`/source/<id>`: nguồn có file cục bộ hiển thị nội dung (Markdown được render, JSON/text giữ nguyên,
đoạn AI đã dùng được tô vàng và tự cuộn tới); nguồn chỉ có liên kết thì mở thẳng liên kết.

| Loại | Ý nghĩa | Ví dụ |
|---|---|---|
| `docs` | Tài liệu trong `knowledge-base/` (knowledge/, app-guides/, docs/…) | `knowledge-base/knowledge/joy/faq.md` |
| `skill` | File skill (`skills/…`, `knowledge-base/skills/…`, SLA skill rules) | `skills/check-ticket/check-ticket-bug/SKILL.md` |
| `kb` | Đoạn trong DB kiến thức (`document_chunks`, từ `hachimi-docs-search.mjs`) | `metadata.chunkId` |
| `elite` | Trích dẫn trong câu trả lời TS Elite 2 (link `ts2.avada.net`, bằng chứng đã đọc) | `RedeemSection.js:52` |
| `ticket` | Ticket Helpdesk đã đọc | `https://helpdesk.avada.net/tickets/JOY-…` |
| `url` | Liên kết ngoài khác (storefront đã mở bằng MCP Playwright…) | |
| `artifact` | File kết quả của run tự động | `runtime/check-ticket/jobs/<job>/<run>/elite.txt` |

Nguồn được ghi từ đâu:

- **Controller tự động**: ticket Helpdesk đã đọc (pha `evidence`), trích dẫn trong câu trả lời ban đầu
  (pha `elite`), hai file skill worker nạp (mỗi pha worker), và mọi lệnh/tool worker Codex đã chạy
  (`codex exec --json` → event `tool`, kèm file `knowledge-base/`/`skills/` xuất hiện trong lệnh).
  Không xuất reasoning.
- **Bridge chat (`codex-ticket-bridge.mjs`)**: extension gửi kèm `traceId` (id lượt widget) → bridge ghi
  các đoạn `knowledge-base/` đã truy xuất (event `retrieval`), SLA skill rules, lệnh/tool của lượt
  synthesis và các nguồn câu trả lời trích dẫn (`### Sources`).
- **Đồng bộ file**: backfill cho job cũ (elite.txt → trích dẫn, skill theo category, artifact từng pha)
  và cho lượt widget trả lời thẳng từ TS Elite 2 (mục Sources ở cuối câu trả lời).
- **Thủ công**: `--doc`, `--skill`, `--kb`, `--url`, `--artifact` (nhiều giá trị cách nhau dấu phẩy)
  hoặc `--sources '<json>'` trên CLI.

```bash
node scripts/hachimi-trace-client.mjs --source manual --id manual-JOY-260925-xxxx-1030 --ticket JOY-260925-xxxx \
  --kind observation --phase classify --text "Đối chiếu tài liệu Joy về tier" \
  --doc knowledge-base/knowledge/joy/membership_partner-tiers-b2b.md --skill skills/check-ticket/SKILL.md
```

Trang xem chỉ đọc file dưới `knowledge-base/`, `skills/`, `docs/`, `runtime/check-ticket/jobs/`,
`runtime/sla-skill-rules.json`, `AGENTS.md`; bỏ qua symlink thoát ra ngoài và file có tên `.env*`,
`*secret*`, `*token*`, `*credential*`, `*password*`, `*.pem`, `*.key`.

## Link từ chat bot của extension

- Menu `⋯` trong Chat bot có nút **Tracing** (dưới History) mở `http://andrewtstracing.localhost:5077`. Mọi link tracing của extension dùng cố định địa chỉ này.
- Mỗi conversation trong History có một nút **Tracing**. Conversation gắn ticket mở `/#ticket/<mã ticket>`:
  mọi phiên của ticket đó từ mọi nguồn (check tự động, widget chat, check thủ công), mở phiên mới nhất.
  Conversation không gắn ticket mở `/#chat/<chatId>`: web lọc các phiên có `metadata.chatId` trùng
  (mỗi lượt chat là một phiên) và mở phiên mới nhất.
- Lượt check tự động trong History (nhãn **Auto check**) mở `/#ticket/<mã ticket>?open=automatic:<id ticket>`:
  vẫn liệt kê mọi phiên của ticket nhưng mở đúng phiên check tự động.
- Đường dẫn khác: `/#session/<id>`, `/#trace/<source>/<externalId>`.
- `chatId` đi cùng event từ `widget-terminal-log.js` → native host (`widget-chat-log`, chỉ giữ id/kind/text/chatId)
  → `runtime/check-ticket/widget-chat.jsonl` → sync vào `trace_sessions.metadata.chatId`. Native host gọi
  `POST /api/sync` ngay sau khi ghi log để web cập nhật gần realtime.

## API

| Method | Đường dẫn | Ý nghĩa |
|---|---|---|
| POST | `/api/trace/events` | Nhận `{ source, id, ticketReference?, subject?, category?, status?, phase?, metadata?, sources?, events:[{kind,text,at?,phase?,actor?,payload?,sources?}] }`; `sources[] = { type, label?, path?, url?, locator?, excerpt?, metadata? }` |
| GET | `/api/sessions?q=&source=&status=active|terminal&chatId=&ticket=&limit=&offset=` | Danh sách phiên (`ticket` khớp chính xác mã ticket) |
| GET | `/api/sessions/lookup?source=&id=` | Tìm id phiên theo `source` + `external_id` |
| GET | `/api/sessions/:id` | Phiên + toàn bộ event + danh sách artifact |
| GET | `/api/sessions/:id/events?after=<seq>` | Event mới hơn `seq` |
| GET | `/api/sessions/:id/artifacts/:artifactId` | Nội dung artifact |
| GET | `/api/sessions/:id/sources` | Toàn bộ nguồn dữ liệu của phiên (kèm `event_seq`) |
| GET | `/api/sources/:id` | Một nguồn + phiên/event gắn với nó + `content` (file đã đọc an toàn, đoạn KB, hoặc link) |
| GET | `/source/:id` | Trang xem nguồn (mở ở cửa sổ mới từ UI) |
| GET | `/api/source-types` | Danh sách loại nguồn và thư mục được phép đọc |
| DELETE | `/api/sessions/:id` | Xóa phiên |
| GET | `/api/stream` | SSE realtime (`events`, `sync`, `purge`, `deleted`) |
| GET | `/api/stats` | Thống kê, lần dọn gần nhất |
| POST | `/api/retention/run` | Dọn phiên hết hạn ngay |
| POST | `/api/sync` | Đồng bộ file → DB ngay |

`kind` hợp lệ: `start, phase, waiting, text, thinking, tool, observation, note, warning, result, done, error, cancelled`.
`done/error/cancelled` đánh dấu phiên kết thúc; `warning` thì không.

## Tự xóa sau 10 ngày

- Mỗi phiên có `trace_sessions.expires_at = started_at + 10 ngày` (tạo lúc ghi).
- Server chạy purge lúc khởi động và mỗi giờ: `DELETE FROM trace_sessions WHERE expires_at <= now()`;
  event và artifact xóa theo (ON DELETE CASCADE). Lịch sử dọn nằm ở `trace_retention_runs`.
- Không có server vẫn dọn được: `npm run trace:purge`.

Kiểm thử: `npm run trace:test` (cần DB đang chạy cho phần integration).

## Analytics API (AI check accuracy)

Cùng server, dữ liệu từ `scripts/hachimi-analytics-store.mjs` (bảng `ai_check_reviews`, `ai_check_feedback`):

- `GET /api/analytics/summary?days=7|30` hoặc `?from=ISO&to=ISO` — tổng đúng/chưa đúng/chưa đánh giá, tỉ lệ, cột theo ngày (≤31 ngày) hoặc tuần, danh sách ticket từng nhóm, trạng thái đồng bộ.
- `GET /api/analytics/tickets?verdict=correct|incorrect|pending&from&to&limit`
- `GET /api/analytics/feedback?ticket=&limit=` · `GET /api/analytics/lessons?ticket=<mã>&limit=` (worker check-ticket dùng)
- `POST /api/analytics/sync` `{ force?, ticketIds?, recentDays?, wait? }` — đọc lại reaction trên Helpdesk (loopback); chạy nền, trả 202 ngay (`wait:true` để chờ). `recentDays` giới hạn ticket gần đây và bị giới hạn 45 giây/lần. `GET /api/analytics/sync` xem trạng thái.
- `POST /api/analytics/train` `{ ticket, description }` — Train AI: lưu feedback, cập nhật `knowledge-base/feedback/ai-check-lessons.md` (loopback). Từ 13/10/2026 sau khi lưu còn gửi nền một tin Telegram "✅ Đã nhận feedback Train AI cho <ticket> …" qua bot sẵn có (`scripts/telegram-send.mjs`; tắt bằng `AI_CHECK_FEEDBACK_TELEGRAM=off`); phản hồi có `telegram: queued|off`.

Reaction của Andrew: 👍/❤️ = đúng, 😢/😭 = chưa đúng (`AI_CHECK_REVIEWER_IDS` để thêm tài khoản). Đồng bộ lúc khởi động và mỗi 10 phút.

Ticket được quét mỗi lượt sync: (1) job `done` có `commentId` trong `runtime/check-ticket/state.json`; (2) dòng đã có trong `ai_check_reviews` (90 ngày); (3) `ticketIds` truyền tay; (4) từ 11/10/2026: ticket Andrew được gán (`memberIds`) có `updatedAt` trong 7 ngày gần nhất, đọc qua `GET /tickets?limit=100` (tối đa 5 trang, dừng khi trang không còn ticket mới) — nhờ đó comment báo cáo do agent đăng tay (Hancal, Handfy…) trên ticket chưa qua luồng tự động cũng được nhận theo dạng (`source = detected`). Ticket phát hiện mà không có comment báo cáo được nhớ theo `updatedAt` và không đọc lại cho tới khi Helpdesk đổi ticket; `force: true` đọc lại hết. `GET /api/analytics/sync` trả thêm `discovered` (số ticket phát hiện trong lượt).

