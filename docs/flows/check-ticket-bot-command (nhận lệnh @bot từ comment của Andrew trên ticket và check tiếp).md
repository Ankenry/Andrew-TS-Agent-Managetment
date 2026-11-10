# Lệnh @han trên comment ticket của Andrew

## Nhận diện ảnh có sẵn trong thread khi thiếu từ “đã” — 10/11/2026

- Command `xy2XhtScryjAXFVP11v5` trên `WDFM-261029-bQBbkz` bị mixed-write từ chối nhầm cụm “image dev gửi ở thread slack”. `LOCATED_MEDIA_EVIDENCE` chỉ che động từ trong bản sao dùng cho mixed-write khi có danh từ ảnh/video, chủ thể và vị trí nguồn kết thúc rõ ràng. Instruction, URL và toàn bộ `FORBIDDEN` giữ nguyên; câu yêu cầu/future tense, người nhận hoặc thao tác gửi/ghi mới vẫn bị chặn.
- Regression kiểm tra nguyên văn lệnh, các biến thể nguồn, gửi/ghi trước và sau dẫn chứng, giữ instruction, một ACK/draft và dedup qua restart, cùng việc kiểm lại command bị sửa. Việc sửa parser không tự replay command cũ; phục hồi riêng lệnh này theo yêu cầu “khắc phục” của Đại tá, giữ ACK `r9eSOCTGEAKHqojB0zwP` và dùng ảnh thay thế `https://capture.avada.io/i/eJnkjqwn7veF`.
- Artifact kiểm chứng và triển khai: `runtime/agent-artifacts/hachimi-wdfm-han-20261110/`. Kết quả source/test và kết quả chạy thực tế được ghi riêng; không coi test pass là bằng chứng notifier đã nạp bản sửa.

Đã triển khai theo yêu cầu trực tiếp của Đại tá ngày 10/11/2026: **147/147 tests đạt**; notifier PID `5623` → `105916` với `--watch --resume-session`. Recovery chỉ gọi `processReply` cho target đã chuẩn bị; POST một draft `mNL48DXqBDgCEc188hci`, GET xác nhận exact body/Andrew/avatar, 4 → 5 comments và một marker đúng command. Giữ ACK cũ, toàn bộ state ngoài target tại thời điểm recovery, các job/lệnh cũ và cursor sau resume; ticket giữ `open`/`customization`. Controller xác nhận notice `drafted` đã gửi. Không gửi email hay sửa shop/status/Done. Health automation started; lỗi GET403 có sẵn ở luồng khác vẫn được giữ và không thuộc bản sửa parser này. Bằng chứng: `verification.json`, `runtime-verification.json`, `deployment-restart.json`, `tests-final.tap` trong thư mục artifact trên.

## Viết lại mail và nhắc tới nội dung — 27/10/2026

- Command `Mxx4AtBwkV2OCohwnmkW` trên `CB-261006-5WstZP` bị từ chối vì guard mention match `nhắc tới` trong câu `sao trong mail không nhắc tới ...`. `viết llại mail` (và cả `viết lại mail`) cũng chưa được `DRAFT_REQUEST` nhận diện. Đây là command mới, khác command video `4ax1DSASkiTKiUeZIazZ` đã done.
- `DRAFT_REQUEST` nhận thêm token `lại/llại/lai/llai` ngay sau động từ viết/soạn/tạo. Không sửa instruction gốc. `MAIL_CONTENT_REFERENCE` chỉ thay từ `nhắc` trong bản sao dùng riêng cho guard mention khi có ngữ cảnh mail/email/thư + `nhắc tới/đến` + nội dung trích dẫn hoặc một từ chỉ chủ đề; không miễn đối tượng bắt đầu bằng `@`. Các guard khác vẫn kiểm toàn bộ action text; mention/tag người thật hoặc yêu cầu gửi/ghi bổ sung trước/sau vẫn bị chặn.
- Regression: câu thật, tới/đến, viết lại/llại, yêu cầu gửi/tag/đổi status và code, giữ instruction, delivery đúng một ACK/draft, restart không replay command cũ và kiểm lại comment bị sửa. Bộ parser/controller/draft/ACK recovery đạt **127/127 tests**.
- Đại tá duyệt `fix lỗi và đăng` đúng command mới. Recovery giữ ACK `vHHWuiyYCrqMsODTNXNY`, draft cũ `kClZVe0lHVDvAnpPSuyR` và dedup; không sửa/xóa nội dung cũ. Chuẩn bị preview đầy đủ comments/Slack, đối soát marker và author/avatar trước/sau. Restart/recovery cần kế hoạch riêng được Hanlead duyệt; ghi kết quả live sau xác minh, không xem tests là bằng chứng đã triển khai.

Đã triển khai theo duyệt Hanlead lúc **13:38:32 ngày 27/10/2026 (UTC+7)**, notifier `66250` → `103448`, đúng một process `--watch --resume-session`, health started. Recovery đọc đủ **38 comments/59 tin Slack**, xác nhận context không đổi, POST **một** draft `LRLA4Omqr0fWzgppDmx7`; GET exact content/Andrew/avatar và **38 → 39 comments**, một marker đúng command. Draft nêu rõ thay currency nhưng page detect sai, nhờ dev theme sửa và giữ Jam. ACK cũ, draft trước, toàn bộ comments cũ và trạng thái ticket giữ nguyên; target `done`. Snapshot chứng minh recovery chỉ đổi target và kind của đúng command; sau resume giữ **52 commands/42 ACK**, cursor tiến theo scan thường, job cũ `NZMLhuBt5XyrlnlZvLJb` chỉ đổi `nextAttemptAt` do GET403 có sẵn, không đổi attempts/status/comment. Controller gửi Telegram drafted `3258`; không gửi email hay đổi status/Done/shop. **127/127 tests đạt**, source hash lúc chạy khớp bản đã review. Evidence: `runtime/agent-artifacts/hachimi-cb-rewrite-20261027/` (`tests-final.tap`, `verification.json`, `runtime-verification.json`, `resume-state-diff.json`, snapshots và `recover.mjs`).

## Sửa phân loại video đã gửi — 27/10/2026

- Command `4ax1DSASkiTKiUeZIazZ` trên `CB-261006-5WstZP` yêu cầu soạn mail và dùng “video tôi đã gửi cho Iris ở comment ticket”. Bộ lọc mixed-write hiểu nhầm từ `gửi` thành thao tác mới; ngoại lệ ngày 26/10 chỉ có ảnh/screenshot và chủ thể bên thứ ba.
- `PAST_MEDIA_EVIDENCE` trong `bot-command.mjs` bổ sung `video`, `link video` và chủ thể `tôi` vào mẫu hẹp có `đã gửi/đăng`. Chỉ che động từ trong bản sao dùng cho mixed-write; giữ instruction nguyên văn và toàn bộ kiểm tra `FORBIDDEN`. Lệnh gửi mới trước/sau dẫn chứng vẫn bị chặn.
- Regression trong `bot-draft.test.mjs`: nguyên văn CB, các biến thể video, lệnh gửi thật trước/sau, giữ nguyên instruction, ACK + draft một lần và dedup qua restart, kiểm lại command bị sửa thành yêu cầu gửi.
- Đại tá đã duyệt sửa và tiếp tục đúng command CB qua Hanlead. Giữ ACK `dc8VsBEUhY4eBSKXTqXM`; đối soát đủ comments và marker trước/sau; không replay command khác. Restart notifier cần kế hoạch được Hanlead duyệt. Kết quả kích hoạt và comment ID được ghi riêng sau xác minh thực tế.

Đã kích hoạt sau duyệt Hanlead lúc **12:52:43 ngày 27/10/2026 (UTC+7)**: notifier PID `5969` → `66250`, đúng một process với `--watch --resume-session`, health started. **122/122 tests đạt**. Đọc đủ 35 comments và 59 tin Slack trước recovery; dùng preview đã kiểm nội dung, gọi `processReply` riêng target khi notifier dừng, không gọi scan/processOne. POST một draft, GET xác nhận comment `kClZVe0lHVDvAnpPSuyR`, exact content/Andrew/avatar, 35 → 36 comments, một marker; ACK cũ không đổi. Giữ video `https://jam.dev/c/a1b05460-ef13-44c7-8e7c-4b142b89fa5e`, không đưa yêu cầu bật Canada vào mail. Trong recovery mọi state ngoài target giữ nguyên; sau resume 51 command và 41 ACK giữ nguyên, cursor tiến theo scan thường. Job cũ `CHAT-261007-uXUfK4` chỉ đổi `nextAttemptAt` do GET403 có sẵn, không đổi attempts/status/comment; không reset hoặc chạy lại analysis của job đó. Controller xác nhận Telegram drafted `3256`; không gửi email, đổi status/Done hay sửa shop. Evidence: `runtime/agent-artifacts/hachimi-cb-han-20261027/` (`verification.json`, `runtime-verification.json`, `resume-queue-diff.json`, snapshot trước/sau và `recover.mjs`).

## Sửa phân loại ảnh đã gửi — 26/10/2026

- Lệnh soạn mail có cụm “link ảnh mà tester đã gửi” trước đây bị `DRAFT_MIXED_WRITE` từ chối vì bắt từ `gửi` mà không xét đây là mô tả ảnh có sẵn. Case xác minh: SRVY-261026-7VdbEH, command `UI05UkhdMBkP10TzgA4D`.
- `skills/check-ticket/scripts/bot-command.mjs` nhận diện hẹp cụm ảnh/hình/screenshot + chủ thể bên thứ ba (tester/dev/developer/QA/khách/merchant) + `đã gửi/đăng`. Chỉ thay động từ trong bản sao dùng cho bộ lọc mixed-write; không bỏ cả câu, không thay instruction, URL hay dữ liệu chuyển cho draft worker. Bộ `FORBIDDEN` vẫn kiểm nguyên văn. Các mô tả khác chưa thuộc mẫu này vẫn được kiểm theo quy tắc hiện có.
- Yêu cầu bổ sung trước hoặc sau cụm ảnh như “gửi luôn”, gửi mail/Slack, xóa, đổi status, tick Done, bật setting hoặc theme push vẫn bị từ chối. `bot-draft.mjs` dùng cùng parser khi kiểm lại comment trước soạn; sửa comment thành lệnh gửi thật vẫn chặn.
- Kiểm thử tại `skills/check-ticket/scripts/bot-draft.test.mjs`: câu thật và biến thể, mixed-write trước/sau, giữ nguyên instruction/link, ACK + draft một lần qua controller giả lập, restart/dedup và kiểm lại command đã sửa. Không dùng test để đăng lên ticket thật.
- Bản sửa code không phục hồi command đã `cancelled/refused`: giữ ACK, state và dedup. Nạp vào notifier cần restart có duyệt với `--watch --resume-session`; chạy lại command cũ cần duyệt riêng, không reset cursor hoặc thêm ACK trùng. Trạng thái triển khai live được xác minh riêng.

Đã nạp bản sửa lúc **17:33:32 ngày 26/10/2026 (UTC+7)** sau duyệt của Đại tá, restart đúng notifier PID `5806` → `105019` với `--watch --resume-session`. Health sau khởi động xác nhận automation started; 46 command cũ và 36 ACK cũ giữ nguyên, session/cursor không reset. Command SRVY cũ vẫn `cancelled`, GET Helpdesk đủ 5/5 comments, chỉ ACK `TY4Qt58k8wfHx75zz7b3`, chưa có draft và không replay. Parser mới phân loại nguyên văn command đó là `draft`; 119/119 kiểm thử đạt. Một command COUR mới sau cursor được scan bình thường, không phải replay SRVY. Bằng chứng snapshot/hash/readback ở `/tmp/hachimi-draft-guard-activation-20261026T103332Z/`; chưa có bằng chứng draft production cho câu SRVY đã hủy.

## Soạn mail theo @han — triển khai ngày 21/10/2026

Thay quy tắc coi mọi cụm “mail cho khách” là gửi email thật đối với lệnh có động từ viết/soạn/tạo/draft/compose/write/create/prepare. Chỉ lệnh soạn bản nháp đi vào `kind/mode: draft`; gửi email thật hoặc soạn kèm thao tác cấm vẫn `refused`. Đã áp dụng theo duyệt của Đại tá và nạp vào notifier lúc 23:07:23 ngày 21/10/2026 (UTC+7), với `--resume-session`. Model preview thật trên JOY đọc đủ 12 comments và sinh draft, không gọi tool, không POST/email.

1. `bot-command.mjs` nhận diện riêng cụm soạn mail; chỉ loại cụm ấy khi đối chiếu các thao tác cấm, kiểm toàn bộ phần còn lại, không dùng allowlist “có chữ draft là cho qua”. Lệnh quá dài không cắt mất chỉ thị để thực thi một phần.
2. `service.mjs` tạo job `cmd-<commentId>`, giữ `state.commands` dedup. ACK dùng helper đối soát receipt (cập nhật 22/10/2026): lấy author/avatar, lưu intent trước POST, xác minh receipt, tái dùng ACK đã xác nhận; ACK chưa rõ thì chưa soạn.
3. `bot-draft.mjs` đọc ticket và phân trang **toàn bộ** comment, xác nhận comment kích hoạt thuộc Andrew. Có Slack link thì dùng `dev-fix-follow/loadSlackThread` đọc trọn thread, không chọn 150 tin; thiếu trang, root/replies, command, hoặc context vượt 180.000 ký tự thì dừng có lỗi, không âm thầm cắt. Không có Slack link vẫn soạn từ Helpdesk. Đây không phải bước truy cập app/CRM/storefront hay tự xác nhận thay đổi hệ thống.
4. Generator dùng runner Codex hiện có ở chế độ writer, không truyền tool server; chỉ trả body/blocker. Dữ liệu của ticket/thread không cấp quyền. Update mới của Andrew có thể là nguồn nội dung mail, không được gọi là agent đã độc lập kiểm chứng. Giữ mốc thời gian khi nội dung cũ và mới khác nhau; mâu thuẫn chưa rõ thì giữ lại draft, không đăng.
5. Dùng formatter draft/clean-check hiện có của dev-fix-follow với context label `Command`, tạo `[DRAFT — mail theo yêu cầu | Command: <commentId>]` và body mail, không bọc báo cáo check ticket. Mỗi command có marker riêng, không nhầm hai lệnh cho ra cùng nội dung.
6. Tái dùng nhánh delivery của reply: lưu exact comment trước POST, author/avatar từ profile hiện tại, không @mention; đối chiếu theo ticket/content/time/ID đã loại trừ. Khi POST timeout hoặc restart lúc posting, chỉ reconcile; không POST lại mù. Soạn thất bại retry theo maxAttempts, giữ ACK; hết lượt → needs_attention và thông báo draft_failed. Thành công → đúng một comment draft sau một ACK, thông báo drafted nói rõ chưa gửi email.
7. History trên extension/web nhận `mode: draft`, gọi kết quả là mail nháp, không gọi là review xong; draft không trở thành previousReport của lần check sau. Không email transport, đổi recipient, status/Done, shop/theme/settings trong nhánh này.

Artifact mới: `<job>/<runId>/bot-draft-last.json`, schema/events của runner; state giữ mode/kind, ACK, exact comment, commentId, attempts, status và artifactDir như delivery hiện hành. Không có state migration hay replay cho `cmd-qt6k2MtoVleaacCfOqXx` đã cancelled/refused; muốn xử lý lại command cũ cần lệnh riêng. CLI `--follow-up` không mang comment ID đã xác minh nên từ chối rõ nhánh draft, không chạy nhầm review; test/preview generator dùng job có comment ID thật hoặc fixture được xác minh.

Test: `node --test skills/check-ticket/scripts/bot-draft.test.mjs scripts/ticket-review-workflow.test.mjs skills/check-ticket/scripts/bot-command.test.mjs skills/check-ticket/scripts/bot-reply.test.mjs scripts/dev-fix-follow.test.mjs scripts/feature-follow.test.mjs scripts/check-ticket-history.test.mjs`. Chỉ fixture/mocked generation/API; không replay job thật hoặc đăng/gửi email thật.

Kích hoạt sau duyệt: kiểm tra hash live so với baseline, hợp nhất với candidate khác trước khi apply, kiểm tests trên kết quả hợp nhất; giữ state/queue/cursor/dedup và dùng `--resume-session` khi restart đúng tiến trình notifier. Không xóa command ID, không rewind cursor, không thêm ACK cho job cũ. Đã kích hoạt gói mail riêng lúc 23:07:23 ngày 21/10/2026 (UTC+7): PID 3772 → 186336, health có `botCommands.drafts`, giữ nguyên command/dedup/ACK và queue. Không áp dụng candidate sửa review của Hanski.

## Mục đích và quyền
Từ bản ngày 14/10/2026, `@han` thay hoàn toàn `@bot` cho lệnh mới, không có alias cũ. Mọi comment lệnh mới của chính Andrew nhận đúng một ACK thuần trên cùng ticket: `Dạ chờ em check xíu nha`. Controller xác nhận ACK trước khi xử lý tiếp; không thêm wrapper, mention hoặc chữ ký. Tên file tài liệu giữ nguyên để các link cũ vẫn dùng được.

Sau ACK, controller phân loại và xử lý theo nhánh đã chọn:
- **follow_up/review**: `@han` trống, “check”, “check tiếp”, “check cho tôi cái này”, “xem lại console”… chạy pipeline kiểm tra chỉ đọc, thành công đăng một report có wrapper chuẩn. Tổng hai comment: ACK và report.
- **chat**: chào, cảm ơn, ok, đùa… trả một câu tự nhiên từ template hoặc model theo cấu hình. Tổng hai comment: ACK và reply.
- **question**: “CS cần báo lại gì với khách”, “ticket này sao rồi?”… model trả lời từ dữ liệu đã có, không mở browser/Source API/DevZone/Crisp. Tổng hai comment: ACK và reply.
- **unsure**: ACK trước khi gọi model; model trả lời hoặc chuyển thành follow_up. Khi đổi nhánh giữ ACK đã có, không đăng lần hai.
- **refused**: yêu cầu đổi status, tick Done, nhắn khách, gửi Slack/Telegram, xóa, sửa theme/setting, đăng nhập admin… chỉ ACK rồi thông báo từ chối Telegram; không gọi model/pipeline và không thực hiện thao tác bị cấm. Tổng một comment ACK.

Lỗi ACK chưa xác nhận: dừng trước model/pipeline, đối soát theo giới hạn rồi báo thất bại Telegram; không POST lại khi kết quả chưa rõ. Lỗi pipeline/reply sau ACK: giữ ACK, không đăng report/reply lỗi hoặc câu xin lỗi. ACK không mở rộng quyền thao tác shop, gửi merchant, đổi trạng thái, xóa hoặc upload. Manual preview không đăng ACK/report/reply và không gửi Telegram.

## Cách gọi và cấu hình
- Andrew viết `@han <nội dung>` trong comment của ticket thuộc roster Andrew. Chỉ `author.memberId === ANDREW_ID`; tài khoản khác không được nhận lệnh. Keyword không khớp `@hanski`, `@han123`, `@han.foo` hoặc `@han-other`; không nhận `@bot` mới.
- `skills/check-ticket/workflow.json` → `botCommand`: `enabled`, `keyword: "@han"`, `keywordSinceAt: "2026-10-14T16:25:44.000Z"`, `maxInstructionChars: 2000`, `pollIntervalMs: null`, `replyTimeoutMs: 120000`, `replyMaxChars: 1200`, `chatTemplates: true`.
- `null` dùng chung scan 5 phút; khoảng quét riêng nếu cấu hình phải từ 60000 ms. ACK gửi ngay khi scan nhận lệnh và lưu job, kể cả review queue đang bận; không có cam kết nhận ngay thời điểm user bấm comment.
- Preview: `node skills/check-ticket/scripts/run.mjs <ticket> --preview --follow-up "<nội dung>" [--since <ISO>]`. Chat/question in reply, follow_up in report; không POST. Pipeline v2 trực tiếp cũng hỗ trợ `--preview --follow-up`.

## Mốc migration và baseline
Mốc chuyển đổi đã chốt là **23:25:44 ngày 14/10/2026 UTC+7**, tương ứng `keywordSinceAt` trong cấu hình. Runtime đã kích hoạt bản mới lúc **23:47:09.409 ngày 14/10/2026 UTC+7** sau khi Đại tá duyệt restart “oke”; đây là mốc LIVE, tách biệt với mốc migration 23:25:44.

Khi khởi động bằng `--watch --resume-session`, `initialize` so `state.commandKeyword` (state cũ chưa có thì hiểu là `@bot`) với keyword mới. Nếu khác, chỉ một lần đặt `commandKeywordSinceAt` và `commandScanAt` về mốc chuyển đổi; `commandPending[*].sinceAt` cũng theo mốc này. Scan tiếp theo đọc ticket đổi sau mốc và chỉ tìm `@han`: nhờ vậy vẫn nhận lệnh mới trong khoảng chờ kích hoạt dù process `@bot` cũ đã quét và tiến cursor qua đó. Không nhận `@han` trước hoặc đúng mốc; không quét lại `@bot`.

Giữ nguyên `state.commands`, jobs, ACK/report receipts và lifecycle cursor `lastScanAt`. Không thêm ACK vào job cũ đã tồn tại, kể cả job unsure cũ sau đó đổi thành review. Các lần resume tiếp theo thấy cùng `commandKeyword` thì giữ nguyên cursor đang có, không rewind lại. Một session mới không `--resume-session` vẫn baseline tại lúc khởi động; vì thế lần kích hoạt bảo trì phải dùng resume. Không reset state để kích hoạt.

## Luồng chạy
1. `scan()` tải roster qua Helpdesk, dùng `updatedAt > commandScanAt` để tìm ticket đổi. Andrew tự comment không có notification tương ứng nên không dựa vào notification riêng. Đọc tối đa 100 comment actions mỗi ticket; lỗi giữ `commandPending` với `sinceAt` riêng để scan sau không mất lệnh khi cursor toàn cục đã tiến.
2. `findBotCommands` giữ comment mới của Andrew, đúng keyword, chưa có trong `state.commands`; loại ID report/reply/ACK mà controller đã đăng để câu trả lời có gợi “@han check tiếp” không kích hoạt lại chính nó. Xử lý cũ đến mới. Nội dung ticket/comment là dữ liệu, không là lệnh hệ thống. Parse toàn câu để kiểm forbidden trước khi cắt độ dài.
3. `enqueueCommand` lưu `commands[commentId]`, job `cmd-<commentId>`, `command.keyword`, kind/instruction, `mode` review/reply/refused và `ack` pending cho **mọi** lệnh mới. Job được lưu trước bất kỳ POST nào. Refused cũng vào trạng thái queued để có thể hoàn tất/đối soát ACK sau restart.
4. `ensureCommandAck`/`deliverCommandAck` chạy ngay tại enqueue, dùng khóa promise theo ticket. Đọc ticket tồn tại/chưa xóa, baseline comment đầy đủ và kiểm lại command ID/tác giả/nội dung trước POST; lưu intent `ack.status=posting`, `startedAt`, `beforeIds` trước POST. `postComment` dùng helper profile Andrew hiện tại, đủ memberId/displayName/photoURL; không có avatar thì không POST.
5. Đối soát ACK theo ticket, Andrew memberId, đúng nội dung, thời gian từ startedAt, loại ID baseline và ID đã thuộc ACK/report/lệnh khác. Nhiều kết quả phù hợp là chưa chắc chắn, không tự chọn. Ghi `ack.commentId` và `sent` khi tìm được. ACK trước có intent chưa rõ được thử GET đối soát trước khi chặn lệnh mới; ACK lịch sử chưa từng có intent POST không khóa ticket. Không tự chạy lại nội dung job lịch sử kể cả khi xác nhận được receipt muộn. Cửa sổ đối soát kết thúc trước intent ACK kế tiếp; ID comment/action trả về từ POST được lưu vào receiptId và GET phải khớp ID đó nếu có. Helpdesk có thể trả object ticket đã cập nhật; không coi ID ticket là receipt comment. Lưu postAcceptedAt/responseKind để phân biệt. Job bị chặn vẫn có backoff/giới hạn.
6. POST mất phản hồi hoặc crash sau intent chỉ được đối soát, không tự POST lại. Restart đổi ACK `posting` thành `uncertain`; `processOne` xác nhận ACK trước nhánh reply/review/refused. Lỗi lưu rõ pha preflight/prior_ack_reconcile/author_lookup/post/reconcile. Author lookup do adapter xác nhận chưa POST được lưu vào abortedIntents và có thể thử lại; lỗi POST hoặc crash vẫn uncertain, không đăng lại. Lỗi preflight trước intent có thể thử lại; hết `maxAttempts` thì `needs_attention` và thông báo lỗi, không chạy yêu cầu.
7. Refused đã ACK thì chuyển `cancelled/refused`, gửi một thông báo `⛔` theo cơ chế notice hiện tại. Nhánh reply gọi template hoặc model không tool (`generateReply`), hậu kiểm body, rồi đối soát/đăng reply thuần. Nhánh review gọi v2 ở follow-up mode, rồi đăng report theo wrapper `Sau khi TS check thì thấy như sau:` và `Đây là loại ticket gì : <category>`.
8. Reply và report được lưu nội dung trước POST và dùng delivery state riêng (`job.comment`, `commentId`, `status`, `deliveryAttempts`), không dùng state ACK làm bằng chứng report đã gửi. Dedupe theo nội dung, cửa sổ comment lệnh và loại ID đã thuộc delivery khác; hai lệnh khác nhau trên một ticket vẫn có ACK và kết quả riêng. Không repost khi delivery chưa rõ.
9. Telegram giữ chuỗi review 📥 nhận → 🔎 check → ✅ hoàn tất hoặc ⚠️ lỗi; reply thành công chỉ một 💬, reply lỗi một ⚠️; refused một ⛔. ACK không thêm Telegram riêng. Notice lưu bền phần đã gửi và messageId; không báo hoàn tất trước khi xác nhận report/reply.

## Nội dung và evidence
- `followUpFor` lấy cửa sổ từ job hoàn tất trước đó (`followUpWindow`), báo cáo trước làm dữ liệu, không làm bằng chứng. `acknowledgementIds` loại ACK đã xác nhận trên ticket khỏi comment mới của pipeline. `replyContext` cũng loại các ACK đó, để không hiểu chúng thành phản hồi khách hoặc lời Andrew.
- Pipeline đọc title/description và comment mới, ảnh bằng `view_image`, Crisp khi cần với cap 120 giây; giữ các luật Source API, cấu hình shop thật, CSS selector ổn định và thử CSS cuối trên storefront headless. Không thay đổi các quyền đó trong tính năng này.
- Reply chỉ dùng ticket, tối đa 20 comment gần nhất, tối đa hai report đã đăng. Mẫu chat chèn `@han`; prompt model gợi `@han check tiếp`. Hậu kiểm cho phép đúng token `@han`, từ chối @mention khác và `@bot`, tên nội bộ/provider, key-like string, wrapper, body rỗng hoặc quá dài. Model được thử lại một lần nếu output hỏng.
- Job cũ giữ keyword hiển thị cũ trong History/Telegram (`jobCommandKeyword`, fallback `@bot` chỉ để hiển thị lịch sử, không là trigger alias). Job mới lưu keyword `@han`.

## State, file và hàm
- `skills/check-ticket/scripts/bot-command.mjs`: `DEFAULT_KEYWORD`, `CHECK_ACK`, `jobCommandKeyword`, normalize config/mốc migration, parser/classifier, author/baseline/dedupe filter, follow-up window.
- `service.mjs`: initialize migration, scan/enqueue, ACK delivery/lock/reconcile, processOne gate, processReply/refused/review, Telegram lifecycle và health.
- `adapters.mjs`: Helpdesk đọc/POST với current-author helper; `findPostedComment` hỗ trợ time/excluded IDs và từ chối kết quả đối soát mơ hồ.
- `bot-reply.mjs`: templates, replyContext bỏ ACK, prompt/model một lượt không tool, hậu kiểm reply. `notifications.mjs`: thông báo từng nhánh, phản ánh đúng ACK được giữ khi reply thất bại. `history.mjs`: request/result dùng keyword đã lưu. `run.mjs`: preview.
- `skills/check-ticket-v2/scripts/prepare.mjs`: bỏ ACK khỏi follow-up evidence, keyword mặc định mới. `run.mjs`: preview trực tiếp dùng `@han`.
- `runtime/check-ticket/state.json`: `commandKeyword`, `commandKeywordSinceAt`, `commandScanAt`, `commandPending`, `commands`; job `ack {content,status,attempts,startedAt,beforeIds,commentId,confirmedAt,reconcileAttempts,nextAttemptAt,lastError}` và delivery report/reply riêng. Không sửa/reset state bằng tay; ngoại lệ duy nhất là recovery có lệnh duyệt cụ thể, dùng helper kiểm điều kiện bên dưới khi controller đã dừng.
- Artifact job và trace: `runtime/check-ticket/jobs/cmd-<commentId>/`, `trace.jsonl`; model reply có `reply-context.json` và `bot-reply-*`; review có `review.json`, `comment.txt`, `v2/`. Không ghi token vào tài liệu, trace hay báo cáo.

## Kiểm thử và giới hạn
Chạy `node --test scripts/ticket-review-workflow.test.mjs skills/check-ticket/scripts/bot-command.test.mjs skills/check-ticket/scripts/bot-reply.test.mjs scripts/check-ticket-history.test.mjs skills/check-ticket-v2/scripts/follow-up.test.mjs` với I/O giả. Các ca trọng điểm: mọi nhánh ACK; refused không thực thi; model đổi nhánh không ACK lần hai; thiếu ACK chặn xử lý; retry/restart mất response không trùng; hai lệnh cùng ticket; migration khoảng chờ từ mốc, không nhận alias/lệnh cũ; job cũ không ACK; reply nhắc keyword không tự tạo lệnh.

Chỉ đọc 100 action mới nhất mỗi ticket nên backlog lớn hơn giới hạn này cần đối soát riêng; không tự replay hay POST bù. ACK/report uncertain không bảo đảm tự phục hồi nếu API không trả comment đã gửi: controller dừng để tránh trùng. Test giả không thay thế kiểm chứng production.

## Kích hoạt
**LIVE từ 23:47:09.409 ngày 14/10/2026 UTC+7.** Đại tá duyệt restart “oke”; Hanski thực hiện. Hanlead đã xác minh health: `botCommands.keyword=@han`, `ackScope=all_commands`, `ackText=Dạ chờ em check xíu nha`. Mốc `keywordSinceAt` giữ nguyên 23:25:44 UTC+7.

Bằng chứng nhánh reply đã được Hanlead đối soát trên ticket `WISH-261014-RX3F5X`, command `g909vJCCewNQJIyOem1b` (các giờ dưới đây thuộc ngày 14/10/2026, UTC+7):
- ACK `yI8syxqU4giGe1uqRhdn`: 23:47:17.896, nội dung `Dạ chờ em check xíu nha`.
- Reply `nSKrxjQX3xz0v5jy7WWy`: 23:47:35.951.
- Telegram message `2651`: sent lúc 23:47:37.031.
- GET Helpdesk xác nhận đúng Andrew/avatar và chỉ một ACK. Bằng chứng này xác nhận nhánh reply trên ticket nêu trên, không thay cho kiểm chứng production mọi nhánh.

Quy trình bảo trì cho các lần restart tiếp theo được Đại tá duyệt:
1. Đọc health/state và process hiện tại; đợi không có job running/posting hoặc ACK posting. Giữ nguyên queue và state; không cần đợi queue rỗng nếu job đang chờ 403.
2. Dừng đúng notifier hiện tại, xác nhận đã thoát rồi từ cwd project chạy `node scripts/ticket-notification-to-telegram.mjs --watch --resume-session` trong screen hiện có theo quy trình bảo trì, giữ log `runtime/telegram-ticket-notifier.log`; chỉ một process. Tránh nút reconnect/native-host vì đường đó hiện chỉ truyền `--watch`.
3. Xác nhận log keyword `@han`, `all-command ACK: Dạ chờ em check xíu nha`; health `botCommands.keyword=@han`, `ackScope=all_commands`, `ackText`, `keywordSinceAt`. State migration chỉ đổi cursor lệnh tới mốc, không reset job/commands/lifecycle cursor.
4. Không tự tạo trigger production. Khi có lệnh thật mới, đối chiếu riêng ACK ID và result ID, đúng author/avatar/nội dung và Telegram. Refused chỉ một ACK. Không ACK bù lệnh cũ đã done.

## Thay đổi
- 14/10/2026, lệnh Đại tá “Tôi muốn áp dụng với tất cả và đổi gọi @bot sang thành @han”: keyword mới không alias; ACK mọi nhánh kể cả refused; giữ ACK khi model chuyển nhánh; migration một lần từ 23:25:44 UTC+7; cập nhật templates/prompt/notice/history/preview và kiểm thử. Hanski triển khai code/config/tests/tài liệu; Hanrul cập nhật AGENTS và skill. Đã LIVE lúc 23:47:09.409 UTC+7 sau lệnh duyệt “oke”; Hanlead xác minh health và ACK → reply → Telegram trên WISH-261014-RX3F5X như mục Kích hoạt.
- 14/10/2026: bản ACK trước chỉ dành cho lệnh check hợp lệ; chưa kích hoạt, được bản mọi nhánh phía trên thay thế.
- 14/10/2026: thêm nhánh chat/question trả lời tự nhiên sau phản hồi về `@bot hi`.
- 13/10/2026: luồng comment command ban đầu `@bot`, follow-up check và Telegram.

### Bằng chứng triển khai mail ngày 21/10/2026

133/133 tests trên source đã apply; 21/21 delivery/context tests chạy với fetch/http/https/socket egress bị chặn. Profile author/avatar đọc được. Model preview không đăng, sau restart JOY còn 12 comments, ACK cũ đúng một bản, không có draft cho command cũ. `state.commands` giữ nguyên, 23 ACK đã xác nhận giữ cùng receipt; hai job cũ trong queue giữ ID/status. Notifier notification state giống nguyên bản, con trỏ review/command chỉ tiến theo scan bình thường. Health vẫn mang lỗi Helpdesk HTTP403 đã có trước triển khai trên queue cũ; gói này không xử lý các job đó. Chưa có command draft mới nên chưa tuyên bố delivery production thành công. Artifact: `/tmp/hancal-mail-draft-fix-20261021/deployment/`.

### Mở đầu/chữ ký theo app — bổ sung 21/10/2026

`customer-mail-format.mjs` dùng appName thật của ticket (exact-name catalog, không suy từ mã ticket/subject). JOY Loyalty mở đúng “I am Andrew from the Loyalty technical support team, and I hope this email finds you well” và kết “Best regards,” / “Andrew, Joy Technical Support Team”. App khác thay bằng tên app đã xác minh; app thiếu/lạ thì fail, không đoán Joy. Bộ soạn @han và formatter draft chung của Dev Fix/Feature Follow truyền appName đến helper. Greeting/self-intro/signature cũ ở đầu/cuối được thay một lần, giữ Subject, đoạn kỹ thuật/URL, kể cả nội dung cùng dòng sau “Hi …,”. Dấu chấm dư cuối signature được chuẩn hóa. Khối chữ ký không nhận diện an toàn thì dừng thay vì xóa nhầm nội dung. Không sửa comment cũ hoặc tự replay.

Formatter mở/kết mail đã nạp vào notifier lúc **23:50:23 ngày 21/10/2026 (UTC+7)** sau restart được duyệt với `--resume-session`; health `botCommands.draftMailFormat=andrew-app-team-v1`, PID mới217224. 143 tests đạt, model preview thật Joy đạt đúng mở/kết một lần, không POST/mail; state/ACK/dedup và comment cũ giữ nguyên. Artifact: `/tmp/hancal-mail-greeting-20261021/`.


### ACK recovery có kiểm soát — 22/10/2026

`ack-recovery.mjs` (`receipt-scoped-recovery-v1`) cung cấp helper operator-only `recoverAckDraft`; scan/startup không tự gọi. Chỉ nhận một draft `needs_attention` ở pha ACK, chưa có intent/receipt hoặc attempt sinh/đăng draft. Kiểm lại command hiện tại của Andrew, chưa có marker draft và tất cả blocker đều thuộc danh sách job lịch sử được duyệt. Lưu snapshot trước recovery vào `ackRecovery`; giữ commands, cursor, receipt/error cũ và mọi job khác. Hai job cũ không chạy lại.

Khi Đại tá cho phép cô lập một ACK cũ chưa đối soát được, `ack.isolatedFor` ghi targetJobId, thời điểm, căn cứ duyệt và lý do. Ngoại lệ chỉ áp dụng đúng target đó; không bỏ guard trên ticket khác/lệnh khác. ACK recovery bắt buộc `requireReceiptId`: chỉ GET khớp ID comment thật đã xác minh, nội dung, Andrew, timestamp và ID baseline mới xác nhận. Nếu POST trả ticket thay vì comment ID, controller không tự chọn theo text; operator đã được duyệt phải đối chiếu một comment mới duy nhất trong cửa sổ POST thành công, đủ author/avatar và baseline, ghi receiptSource/proof bằng GET rồi mới tiếp tục. POST không rõ kết quả vẫn dừng, không tự POST lại. Không gán receipt giả cho job lịch sử.

Recovery vận hành: backup/hash code và state; kiểm health không running/posting, đóng băng và kiểm lại intent/Telegram sending; dừng đúng notifier. Dùng service không timer/scan để chạy duy nhất ACK và draft được duyệt, kiểm GET ID/nội dung/current-author/avatar/duy nhất một marker, đối chiếu các job ngoài phạm vi không đổi. Khởi động lại đúng một notifier với `--watch --resume-session`; xác minh health `ackDeliveryVersion`. Không gửi email thật hoặc sửa shop/status.

Tests bổ sung `node --test skills/check-ticket/scripts/ack-recovery.test.mjs`: receipt muộn, ACK của lệnh khác, author lookup/POST/reconcile error, command biến mất, unknown POST/restart, old unresolved và recovery một job. Kết hợp bộ controller/draft/formatter trước triển khai. Artifact triển khai/recovery: `/tmp/hancal-chat-ack-recovery-20261022/`; kết quả live được ghi riêng sau readback, không xem tests là bằng chứng đã đăng.


Đã triển khai và recovery theo lệnh “sửa lỗi và đăng”: notifier PID 217224 → 231936, khởi động lúc **00:06:47 ngày 22/10/2026 (UTC+7)** với `--watch --resume-session`; health `ackDeliveryVersion=receipt-scoped-recovery-v1`. 154/154 tests đạt; 33/33 tests ACK/draft đạt khi chặn egress. API POST thực tế trả ticket đã cập nhật; đã bổ sung regression không nhận ticket ID làm receipt. Với recovery này, ACK được xác nhận qua GET theo ID thực, baseline, cửa sổ POST thành công, Andrew/avatar và chỉ một candidate; có proof/correction audit, không POST ACK lần hai.

Command `9lAdsOkPstasXsxt0fUd` trên `CHAT-261021-qfK279` đã done: ACK `xg4HP818ZNYmrI4GJolW`, draft `H8h0SnSVHJG0emjiWJdZ`. GET xác nhận đúng nội dung/author/avatar và một draft theo marker command, đúng hai POST tổng cộng. Mail đủ hai câu trả lời, opening/signature Chatty; không gửi email. Hai command cũ `plL62E4YQW94OHXcb3oU` và `aWNwGyZpfMbIgfNExfj3` giữ needs_attention, không có receipt bịa hoặc replay. ACK unresolved cũ chỉ được cô lập cho target đã duyệt, không mở ngoại lệ cho lệnh khác.

Trong cửa sổ recovery dừng controller, chỉ ba job trên thay đổi; global state/dedup/cursor và mọi job khác nguyên vẹn. Sau resume, 36 command cũ giữ nguyên, một command mới đúng sau cursor được scan bình thường (ACK sent, responseKind ticket); hai job queue cũ vẫn giữ ID, lỗi GET403 của queue cũ ngoài phạm vi không bị reset. Chi tiết scrub và readback: `/tmp/hancal-chat-ack-recovery-20261022/verification.json`, `runtime-verification.json`, `DEPLOYED.md`.


## Thay đổi 22/10/2026 — Slack cho nhánh review (candidate chưa reload)

`@han check` vào shared v2 sẽ đọc đầy đủ thread đính kèm ticket qua backend trước model. Link được lấy từ field/mô tả/comment phân trang đầy đủ trong budget; thiếu nguồn bắt buộc hoặc lỗi đọc trả incomplete, giữ ACK đã xác nhận và không đăng report thành công. Reply Slack không bị lọc theo sinceAt của Helpdesk. Verifier kiểm quote đúng message và buộc report dùng phản hồi kỹ thuật và correction dù message cuối là ACK, chặn khẳng định dev chưa trả lời khi thread có reply. `followUpWindow` loại reply/draft, lấy review kỹ thuật làm baseline; không sửa scan cursor, commands, receipts hay state lịch sử. Không thay nhánh mail draft/dev-follow hoặc quyền ghi. Chi tiết, giới hạn và test ở flow check-ticket-v2, mục “Đọc Slack bắt buộc trước review”.

Revision R2 22/10/2026: Helpdesk pagination và completeness gate, intent từ nội dung ticket/comment, correction coverage/chống hồi sinh kết luận cũ, redaction exact backend token. Không thay delivery/state/ACK; xem flow check-ticket-v2 và slack-revision.test.mjs.

Revision R3 22/10/2026: intent chỉ bật mandatory khi URL thread thật hoặc yêu cầu rõ đọc/đối chiếu dev reply/nội dung hội thoại. Câu hỏi tích hợp Slack và multithreading không bị chặn missing_thread_link chỉ vì từ khóa. Từng field/comment/followUp được nhận diện riêng; không đổi ACK, state hoặc delivery.
