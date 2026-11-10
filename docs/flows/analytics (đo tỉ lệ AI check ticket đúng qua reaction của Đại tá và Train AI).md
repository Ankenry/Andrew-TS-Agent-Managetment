# Analytics (đo tỉ lệ AI check ticket đúng qua reaction của Đại tá và Train AI)

## Mục đích

Mục **Analytics** trên thanh điều hướng (extension Chrome và TS Management web, giữa Checking và Notifications) cho Đại tá biết AI check ticket đúng bao nhiêu phần trăm. Mỗi comment báo cáo của AI trên Helpdesk (wrapper TS `Sau khi TS check thì thấy như sau:` (hiện tại và cũ) hoặc lời chào Han Support và đủ mục 2/4/6 của giai đoạn trước) là một lượt chấm: Đại tá react 👍 hoặc ❤️ là đúng, 😢/😭 là chưa đúng, chưa react là chưa đánh giá. Phần **Train AI** lưu feedback của Đại tá để các lượt check sau không lặp lại lỗi cũ.

Toàn bộ luồng chỉ đọc Helpdesk (danh sách ticket, action comment và reaction). Không đăng comment, không react, không đổi status.

## Cách Đại tá dùng

1. Trên Helpdesk, react vào comment báo cáo của AI: 👍/❤️ (đúng) hoặc 😢/😭 (chưa đúng).
2. Mở mục Analytics trên extension hoặc web `http://andrewtsmanagement.com:5088`. Chọn khoảng 7 ngày, 30 ngày hoặc tùy chọn. Trang hiện biểu đồ tròn đúng/chưa đúng/chưa đánh giá, cột theo ngày (hoặc tuần khi khoảng dài hơn 31 ngày), ba danh sách ticket và tỉ lệ toàn thời gian.
3. Bấm **Đồng bộ reaction** để đọc lại Helpdesk ngay thay vì chờ chu kỳ.
4. Bấm **Feedback** ở một ticket (hoặc dán link ticket), mô tả AI đúng/sai ở đâu và nên trả lời thế nào, bấm **Train AI**.

## Luồng từng bước

### A. Đồng bộ reaction (`syncReactions` trong `scripts/hachimi-analytics-store.mjs`)

1. **Khi chạy**: tracing web 5077 khởi động; mỗi 10 phút (`reactionSyncIntervalMs` trong `createTraceWeb`, `scripts/hachimi-trace-web.mjs`); mỗi 60 giây khi trang Analytics đang mở (trang gọi `POST /sync {recentDays: 3}`, server giới hạn một lần mỗi 45 giây); khi bấm Đồng bộ reaction (`POST /sync {}`); hoặc khi gọi tay `POST /api/analytics/sync {ticketIds: [...], wait: true}`.
2. **Gom danh sách ticket cần đọc**, bốn nguồn:
   - job `status: done` có `commentId` trong `runtime/check-ticket/state.json` (comment do controller tự động đăng; nguồn `automatic`);
   - dòng đã có trong bảng `ai_check_reviews` với `comment_at` trong 90 ngày;
   - `ticketIds` truyền tay trong body;
   - **phát hiện** (từ 11/10/2026): ticket Andrew được gán (`memberIds` chứa `ANDREW_ID` hoặc `AI_CHECK_REVIEWER_IDS`) có `updatedAt` trong 7 ngày (`DISCOVERY_DAYS`), đọc qua `GET /tickets?limit=100` tối đa 5 trang, dừng khi trang không còn ticket trong cửa sổ (`recentAssignedTickets`, `pickRecentAssigned`). Ticket đã đọc mà không có comment báo cáo được nhớ theo `updatedAt` trong bộ nhớ tiến trình (`discoverySeen`) và không đọc lại cho tới khi Helpdesk đổi ticket (một comment mới luôn đổi `updatedAt`). `force: true` bỏ bộ nhớ này. Khi có `ticketIds` thì không phát hiện thêm. Nguồn này tồn tại vì comment báo cáo do agent đăng tay (Hancal, Handfy) nằm trên ticket mà state.json và bảng chưa biết.
   - Với `recentDays > 0` chỉ giữ ticket có comment mới hơn `recentDays` ngày (hoặc chưa có comment nào) và cửa sổ phát hiện thu lại bằng `recentDays`.
3. **Đọc từng ticket** (`syncTicket`): `GET /tickets/:id/actions?type=commentTicket&limit=100`, tuần tự, cách nhau 250 ms, lùi 2 s/5 s/10 s khi Helpdesk trả 429. Mỗi action là comment báo cáo khi: nằm trong job của controller, **hoặc** đúng dạng (`isAiReviewComment`): author.memberId là Andrew, **không có** `author.authUid` (comment Đại tá gõ tay trên web có authUid; comment đăng qua API key thì không) và nội dung có wrapper TS hoặc đúng lời chào Han Support kèm thứ tự tiêu đề 2/4/6 (tiêu đề trong code fence không tính). ACK, chat và mail draft không phải report; known jobs loại mode reply/draft và dùng `job.ticketId || job.id`. Category bản compact lấy từ metadata job, không đoán từ mục 2. Comment đúng dạng ngoài job có nguồn `detected`; mã ticket và tiêu đề lấy từ nội dung comment, từ listing phát hiện, hoặc một lượt `GET /tickets/:id`.
4. **Chấm** (`verdictFromReactions`): đọc `reactions` của action (`{"👍": [uid, ...]}`), chỉ tính uid trong `AI_CHECK_REVIEWER_IDS` (mặc định tài khoản Andrew). 😢 😭 😿 🥲 😥 👎 ❌ → `incorrect`; 👍 ❤️ 👏 ✅ 💯 → `correct`; có cả hai thì `incorrect` thắng; không có → `pending`. Tông da và variation selector bị bỏ khi so.
5. **Ghi** (`upsertReview`): `INSERT ... ON CONFLICT (comment_id)`; `judged_at` giữ nguyên khi verdict không đổi, đặt lại khi đổi, xóa về NULL khi về pending.
6. **Comment biến mất**: khi action log đủ (dưới 100 action) mà không còn comment của một job → dòng của comment đó bị xóa khỏi bảng để không tính nữa. Đây là việc hệ thống tự làm theo dữ liệu Helpdesk, không phải xóa tay.
7. Trạng thái lượt sync (`running`, `lastRun`, `lastError`, `tickets`, `discovered`, `comments`) trả ở `GET /api/analytics/sync` và trong `summary.sync`.

### B. Hiển thị (`chrome-extension/analytics-view.js`, dùng chung)

1. Web phục vụ cùng file tại `/analytics-view.js` (`SHARED_SCRIPTS` trong `scripts/ts-management-web.mjs`); extension nạp từ gói của nó. `globalThis.AnalyticsView = { css, mount(root, {api, openUrl, dark}) }`.
2. Trang gọi `api("/summary?days=7")` (hoặc `from/to`), vẽ biểu đồ tròn (`renderPie`), cột (`renderBars`), ba danh sách (`renderTicketList`), form feedback (`renderFeedbackForm`) và lịch sử feedback (`renderFeedbackHistory`). Tự vẽ lại mỗi 15 giây khi đang hiện; mỗi 60 giây gửi `POST /sync {recentDays: 3}`.
   - Biểu đồ cột là SVG vẽ theo bề rộng thật của thẻ (pixel), `viewBox = 0 0 <bề rộng> 170`, không dùng `preserveAspectRatio="none"`; `ResizeObserver` trên `.an-bars` vẽ lại khi bề rộng đổi (xoay máy, kéo cửa sổ, panel extension). Chữ trục, nhãn % và cột giữ nguyên tỉ lệ ở mọi bề rộng; cột rộng 26–56 px tùy chỗ trống, nhãn ngày thưa dần khi hẹp. Từ 960 px, hai thẻ biểu đồ (tròn và cột) nằm cạnh nhau (`.an-charts` hai cột).
3. Nút Đồng bộ reaction: `POST /sync {}` rồi poll `GET /sync` mỗi 3 giây tới khi `running` về false, tối đa 40 lần.
4. Đường đi của `api`:
   - **TS Management web**: trang gọi `/api/analytics/<summary|tickets|feedback|lessons|sync|train>`, server 5088 proxy sang tracing web `http://127.0.0.1:5077/api/analytics/...` (`traceWebJson`, dòng ~1310 `scripts/ts-management-web.mjs`). Chỉ GET và POST sync/train được proxy.
   - **Extension**: `widget.js` gửi message `analytics` tới `chrome-extension/background.js` (case `"analytics"`, ~dòng 1616), background gọi tracing web 5077 trên loopback.
5. Tracing web (`scripts/hachimi-trace-web.mjs`, nhánh `parts[1] === 'analytics'`) từ chối request ghi (sync, train) không đến từ loopback; thiết bị LAN chỉ xem.

### C. Train AI (`trainFeedback`)

1. Form gửi `POST /train {ticket, description}`; server lấy mã ticket từ link hoặc chữ (`parseTicketReference`), tìm review mới nhất của ticket trong `ai_check_reviews` để gắn `review_id`, verdict, category, subject; ghi vào `ai_check_feedback` (`status: trained`, tối đa 6.000 ký tự).
2. Sau khi ghi, `writeLessonsFile()` xuất bản sao `knowledge-base/feedback/ai-check-lessons.md` (chỉ tiện đọc; bảng là nguồn chính).
2b. **Báo Telegram đã nhận feedback** (lệnh Đại tá 13/10/2026 "khi tôi gửi feedback thì báo bot trên tele đẩy thông báo cho tôi biết là bạn đã nhận được feedback"): ngay sau khi dòng feedback được lưu, `trainFeedback` gọi `scheduleFeedbackNotice()` chạy nền (không chặn phản hồi 201) gửi một tin qua bot Telegram sẵn có (`scripts/telegram-send.mjs`, cùng `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` với notifier) dạng: `✅ Đã nhận feedback Train AI cho <mã ticket> (<loại>, <AI check đúng|AI check chưa đúng|chưa đánh giá>): <mô tả rút gọn ≤ 200 ký tự>` + `Bài học đã lưu, áp dụng từ lượt check tiếp theo.` + link ticket. Áp dụng cho cả web 5088 và extension vì cả hai đều đi qua `POST /api/analytics/train` của tracing web. Mỗi feedback (id) chỉ gửi một tin trong tiến trình (lưu lại cùng ticket → feedback mới → tin mới); gửi lỗi thì thử lại một lần sau 3 giây rồi chỉ ghi log `[analytics] Telegram feedback notice failed…`, feedback vẫn đã lưu. Phản hồi của route có thêm `telegram: "queued" | "off"`. Tắt bằng `AI_CHECK_FEEDBACK_TELEGRAM=off` (env hoặc `.env_my`; mặc định bật). Không báo khi reaction được đồng bộ (chưa có lệnh).
3. Worker check-ticket (`skills/check-ticket/scripts/worker.mjs`, `feedbackLessons`) gọi `GET /api/analytics/lessons?ticket=<mã>&limit=40` khi bắt đầu mỗi pha: server xếp feedback cùng app (tiền tố mã ticket) trước, mới nhất trước, giới hạn ~6.000 ký tự, worker nhúng thành mục "Lessons from the user's feedback…" trong prompt (`lessonsPromptSection`). Feedback là dữ liệu, không phải lệnh. Tracing web tắt thì review vẫn chạy, chỉ thiếu bài học (timeout 4 giây).

## File và vai trò

- `scripts/hachimi-analytics-store.mjs`: toàn bộ logic — `reviewerIds`, `verdictFromReactions`, `isAiReviewComment`, `pickRecentAssigned`/`recentAssignedTickets` (phát hiện ticket), `syncTicket`, `syncReactions`, `summary`, `listReviews`, `bucketize`, `listFeedback`, `trainFeedback`, `lessons`, `writeLessonsFile`.
- `scripts/hachimi-trace-web.mjs`: API `/api/analytics/*`, lịch sync 10 phút, chặn ghi từ LAN.
- `scripts/ts-management-web.mjs`: proxy `/api/analytics/*` sang 5077; phục vụ `/analytics-view.js`.
- `chrome-extension/analytics-view.js`: giao diện chung; `chrome-extension/background.js` (case `analytics`), `chrome-extension/widget.js` (mount mục Analytics).
- `skills/check-ticket/scripts/worker.mjs`: nạp lessons vào prompt.
- `scripts/helpdesk-http.mjs`: HTTPS IPv4 cho Helpdesk.
- `scripts/telegram-send.mjs`: `telegramConfig`, `sendTelegramText` (một tin, token không bao giờ vào lỗi/log); CLI `node scripts/telegram-send.mjs "<text>"` để thử. Trong store: `feedbackNotice` (soạn tin), `feedbackNoticeEnabled`, `scheduleFeedbackNotice` (chống trùng theo id, chạy nền, thử lại một lần).
- `db/schema.sql`: bảng `ai_check_reviews` (dòng ~145) và `ai_check_feedback` (~167).
- `scripts/hachimi-analytics-store.test.mjs`: test đơn vị (`npm run analytics:test`).
- `scripts/hachimi-trace-web.README.md`, mục "Analytics API (AI check accuracy)": mô tả API.

## Dữ liệu lưu

- Postgres `hachimi`, bảng `ai_check_reviews`: một dòng mỗi comment báo cáo (`comment_id` duy nhất, `ticket_id`, `ticket_reference`, `subject`, `category`, `source` automatic|detected, `comment_excerpt`, `comment_at`, `verdict` pending|correct|incorrect, `reaction_emoji`, `reactions` jsonb, `judged_at`, `synced_at`).
- Bảng `ai_check_feedback`: feedback Train AI (`ticket_reference`, `review_id` → reviews, `verdict`, `category`, `subject`, `description`, `status`, `created_at`).
- File `knowledge-base/feedback/ai-check-lessons.md`: bản sao feedback.
- Bộ nhớ tiến trình (mất khi restart tracing web): `syncState`, `lastRecentRun`, `discoverySeen`.

## Cấu hình và quyền

- `API_AVADA_TICKET` trong `.env_my`: key Helpdesk (chỉ đọc trong luồng này). Không dán ra ngoài.
- `AI_CHECK_REVIEWER_IDS` (env hoặc `.env_my`, phân cách dấu phẩy): tài khoản được tính reaction; mặc định Andrew `HEYWuzF9rTdG59pE8TNtBKL6W1x1`.
- `AI_CHECK_FEEDBACK_TELEGRAM` (env hoặc `.env_my`): `off`/`0`/`false` tắt tin Telegram "đã nhận feedback"; mặc định bật. Bot/chat lấy từ `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` sẵn có.
- `HACHIMI_TRACE_WEB_URL` cho worker khi tracing web không ở `127.0.0.1:5077`.
- Tracing web chạy bằng systemd user `andrew-hachimi-trace-web.service`; đổi code store/trace web thì `systemctl --user restart andrew-hachimi-trace-web.service`.
- Ghi (sync, train) chỉ từ loopback hoặc qua TS Management web; LAN chỉ đọc.

## Giới hạn

- Chỉ reaction của tài khoản trong `AI_CHECK_REVIEWER_IDS` được tính; người khác react không ảnh hưởng.
- Comment báo cáo chỉ được nhận khi mở đầu đúng `Sau khi TS check thì thấy như sau:` và đăng qua API key (không có `authUid`). Comment Đại tá gõ tay cùng mở đầu không được tính.
- Phát hiện ticket chỉ nhìn 7 ngày `updatedAt` và tối đa 500 ticket mỗi lượt; comment tay trên ticket cũ hơn cần `POST /api/analytics/sync {ticketIds: [...]}` một lần, sau đó ticket đã có dòng trong bảng nên được đọc đều.
- Cửa sổ sync 90 ngày theo `comment_at`; reaction đổi trên comment cũ hơn không cập nhật.
- Một lượt sync đầy đủ đọc một request mỗi ticket (khoảng 170–200 ticket, 1–2 phút); lượt `recentDays` nhẹ hơn và bị giới hạn 45 giây/lần.
- Reaction trên action log chỉ có khi Helpdesk trả field `reactions`; action không có field này được coi là chưa đánh giá.

## Cách test

- Đơn vị: `npm run analytics:test` (verdict, nhận dạng comment, mã ticket, bucket, range, lessons, phát hiện ticket). Thêm 13/10: soạn tin Telegram feedback, chống trùng/thử lại/tắt bằng env với hàm gửi giả, `sendTelegramText` không lộ token (11 test).
- Tin Telegram thật: `node scripts/telegram-send.mjs "test"` gửi một tin thử qua bot sẵn có; không tạo feedback giả trên ticket thật.
- Trạng thái sync: `curl -s http://127.0.0.1:5077/api/analytics/sync`.
- Sync tay một ticket (ghi bảng, không đụng Helpdesk): `curl -s -X POST http://127.0.0.1:5077/api/analytics/sync -H 'content-type: application/json' -d '{"ticketIds":["<id nội bộ>"],"wait":true}'`.
- Kiểm tra một comment trên Helpdesk có reaction và đúng dạng: `GET /tickets/<id nội bộ>/actions?type=commentTicket&limit=100` với `X-API-Key`, xem `author.memberId`, `author.authUid`, `reactions`.
- Số liệu: `curl -s "http://127.0.0.1:5077/api/analytics/summary?days=7"`.

## Thay đổi
- 2026-10-13: Hanbui thêm tin Telegram "✅ Đã nhận feedback Train AI …" gửi nền ngay sau khi lưu feedback (lệnh Đại tá), `scripts/telegram-send.mjs` + `scheduleFeedbackNotice` trong store, biến `AI_CHECK_FEEDBACK_TELEGRAM`, test giả; tracing web restart để nạp.

- 2026-10-11 (18:41): Hanbui sửa biểu đồ cột bị kéo giãn ngang trên desktop rộng (ảnh Đại tá capture FiTMTH1PjYcw, màn 1913 px): `renderBars` trong `chrome-extension/analytics-view.js` trước đó dùng viewBox cố định 360×170 với `preserveAspectRatio="none"` và CSS `width:100%`, nên SVG bị scale ngang 4,4 lần. Nay vẽ theo bề rộng thật + ResizeObserver, thêm layout hai cột từ 960 px. Kiểm bằng Playwright headless 1913/1366/390 px: `runtime/screenshots/analytics-bars-{before,after}-<rộng>.png`.

- 2026-10-11: Hanbui thêm nguồn phát hiện ticket Andrew được gán có cập nhật trong 7 ngày vào `syncReactions` (lệnh Đại tá 17:45 "kiểm tra lại luồng analytics, tại sao đã react vào comment AI post nhưng không thấy sync lên"; nguyên nhân: comment Hancal đăng tay trên AIR-261011-Nf2D6y và APPT-261011-E3vKUR nằm trên ticket không có trong state.json và bảng nên không được quét). Thêm `discovered` vào trạng thái sync, test `pickRecentAssigned`, viết flow doc này (trước đó chưa có).

## Thay đổi 25/10/2026
- Nhận diện report Han Support compact lịch sử và wrapper TS hiện tại/cũ; loại ACK/chat/mail, không thay đổi lịch sử hay reaction. Cần reload tracing web để nạp module Analytics mới; không tự restart trong task.

## 04/11/2026 — core trước quyết định đánh giá trực tiếp (lịch sử)

Yêu cầu mới đang triển khai candidate UI Han auto: list auto-event ticket, mở header và comment paginated, hội thoại app-local riêng. Đây **chưa phải nguồn chấm điểm Analytics mới**. Đại tá sau đó đã chọn nút Đúng/Sai + góp ý, thay cho AI discussion; contract mới bên dưới thay phần pending này. Chưa có rating button/verdict endpoint/schema migration, không đọc chat để tự suy đúng/sai và không biến pending thành incorrect.

Audit read-only04/11 08:57–08:59 UTC+7: reaction settings file/runtime5077/proxy5088 cùng `enabled=false,revision=0`; Trace khỏe; DB323 report gồm50correct/9incorrect/264pending vẫn là dữ liệu lịch sử. Core mới không bật sync, sửa setting, gọi Analytics write hay rewrite323rows. Train AI vẫn là nhánh riêng; discussion Submit không gọi trainFeedback hoặc relay trace vào named-agent session.

Discussion đã dừng, generation không đăng ký trong flow mới. Không cần đổi provider/account/model. Chi tiết source/baseline/tests/capability tại flow Checking và `runtime/agent-artifacts/han-auto-core-20261104/`.

PLAN evaluation đã được duyệt với application principal/auth_method đúng thực tế, không private-key UX mới; implementation candidate mô tả dưới đây. Không migrate hay đánh giá lại lịch sử theo ngầm định. Trace–Analytics không cần restart cho candidate core hiện tại.


## Nguồn chấm mới — candidate Đúng/Sai + góp ý (chưa activation)

Han auto dùng cùng form web/extension, explicit Save, không inference hoặc auto verdict. New4tables `ai_check_evaluation_reports/current/events/comment_links` độc lập `ai_check_reviews`/`ai_check_feedback`. Legacy323rows ở audit04/11 được giữ; activation đọc lại snapshot thật chứ không ép số323. Dedicated additive migration `db/migrations/20261104_ai_check_assessments.sql` chỉ chạy sau duyệt production, không generic schema migrator/backfill/reset. Missing schema => legacy-only read + assessment unavailable; existing unknown/drifted schema => fail rõ, không silently bỏ direct priority.

`loadEffectiveAssessmentRows`/`effectiveAssessmentRows` gom toàn bộ legacy rows, persisted targets và eligible live auto results. One stable effectiveId mỗi report/run; reportId độc lập commentId, hash payload immutable. Direct verdict ưu tiên mapped reaction khi có verified receipt alias đúng ticket/job/run/hash; chưa direct thì legacy verdict giữ nguyên; không có cả hai là pending. Source origin automatic/detected giữ riêng với `judgmentSource` direct-assessment/legacy-reaction/auto-unassessed. Unposted không chế commentId. Registry snapshot/audit không bị trace retention cascade. Alias metadata đến sau do local-state reconciler, không gọi Helpdesk hay đổi điểm.

Alias mâu thuẫn không được ghi đè hoặc đoán ticket/run. Dòng thiếu bằng chứng identity có cờ `excludedFromTotals`, counter và danh sách cảnh báo riêng; dữ liệu gốc vẫn giữ. Registered historical result có hash khác current same-run body được đánh dấu source-conflict, không gắn điểm cũ lên body mới. Metrics/buckets tính trên toàn effective set; list100/page có cursor, không cắt1000 rồi gọi là tổng. SQL fixture >1200rows xác nhận totals/buckets/list paging hòa khớp.

Writer5088 trực tiếp DB, không proxy qua5077 để launder loopback thành owner. Gate existing web/tailnet + JSON/non-ambient header/trusted Host/Origin/registered extension integration. PIN-OFF remote không có verified principal chỉ đọc; local application actor có label “TS Management — chưa xác minh danh tính cá nhân”, channel/auth_method server-owned. Không private key UI, không gán cứng Andrew, không dùng author từ client. Chi tiết auth/Save CAS/receipt tại flow Checking.

Góp ý assessment chỉ annotation. Không gọi trainFeedback/writeLessonsFile/Telegram/model/Helpdesk. Train AI cũ được ghi rõ “Train AI riêng”; không tự xuất note thành bài học. Reaction sync vẫn OFF/revision0; nếu được bật lại trong tương lai thì chỉ cập nhật legacy table, không thể overwrite direct tables/verdict effective.

62tests candidate (final-tests-2.log) bao gồm PostgreSQL16 database test RIÊNG được giữ lại, metadata-only reconcile, actor spoof/proxy/origin/unknown schema, shared browser web/extension desktop/mobile và old canonical/history regression. Không production verdict canary; không production DDL/restart/reload. Flow/provider/progress task cũ không được tiếp tục. Activation/rollback phải giữ schema/audit/assessment mới và compatible reader, không restore DB backup đè dữ liệu.
