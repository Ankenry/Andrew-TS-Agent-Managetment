# Andrew Brain — Second Brain và trợ lý theo nguồn

## Trạng thái hiện tại — 10/11/2026

Andrew Brain có cửa sổ GTK/WebKit riêng mở từ icon desktop và bản web local tại `http://127.0.0.1:5191/`. Workspace chính gồm rail trái, thanh agent trên, checklist và chat giữa, folder/file phải; Thư viện Brain giữ luồng ghi chú phía dưới. Checklist lưu riêng, Brain và source project chỉ đọc. Chat Workspace dùng đúng phiên Codex local đang chạy trong Orca; trợ lý AI theo nguồn của Thư viện Brain vẫn chưa kết nối.

## Luồng Workspace, chat và co giãn pane — 10/11/2026

1. `src/App.tsx` đọc GET `/api/workspace` để lấy checklist, file được phép và metadata Orca trong đúng workspace. Không tự gửi prompt khi mở app/chọn agent.
2. Focus ô Thêm công việc dùng viền amber liên tục quanh toàn bộ form, gồm icon và nút thêm. Input bên trong không có vòng outline riêng; keyboard focus vẫn hiện trên khung cha.
3. `src/ResizablePanes.tsx` giữ nguyên hai section checklist và chat, đặt separator 9px ở giữa. Kéo trái/phải bằng pointer capture để thay đổi tỷ lệ, không remount chat hay gọi API agent. Thả chuột hoặc mất capture thì dừng kéo.
4. Separator nhận Tab và có role/label/giá trị cho assistive technology. ←/→ đổi 1 điểm phần trăm, Shift đổi 10, Home/End tới giới hạn, Enter hoặc double-click đặt về tỷ lệ đều trong giới hạn hiện tại. Tỷ lệ chỉ nằm trong state cửa sổ.
5. ResizeObserver cập nhật giới hạn khi cửa sổ đổi kích thước: checklist ít nhất 280px và chat 320px khi tổng phần pane đủ 600px; giới hạn chung 25–75%. Khi không đủ chỗ, giữ tỷ lệ đều và khóa kéo. Mobile 760px trở xuống ẩn separator, dùng các tab Công việc/Giao việc/Files như trước.
6. Checklist POST `/api/workspace/tasks` thêm/đánh dấu task; DELETE cùng route nhận JSON `{id}` xóa đúng task sau khi người dùng bấm thùng rác bên cạnh nút đưa vào chat. Cả hai cần cùng Origin, JSON và intent; backend khóa/ghi nguyên tử, DELETE idempotent khi retry sau mất response, chỉ thay mảng tasks và giữ chat metadata. UI chờ kết quả rồi bỏ dòng/cập nhật đếm/thông báo; lỗi giữ task và chỉ rõ bấm thùng rác để thử xóa lại. Nút Tải lại checklist chỉ refresh và xóa lỗi hiển thị, không tự retry DELETE; pending khóa thao tác. Focus bàn phím chuyển sang task lân cận hoặc ô thêm việc. Chỉ cập nhật state app. Duyệt file GET `/api/workspace/file` giữ allowlist, chặn symlink/secrets và không ghi source.
7. Chọn agent mở `/api/workspace/chat` và stream `/api/workspace/chat/events` với intent. Bridge kiểm terminal handle, incarnation, workspace và native Codex session của process đang chạy. Chỉ public user/assistant messages, commentary và activity được đưa vào UI; loại private reasoning/system/developer/tool logs/subagent sessions.
8. Submit rõ ràng gửi qua Orca CLI vào đúng terminal. Chiều nhận đọc structured conversation của chính phiên Codex đó, không khởi tạo provider/harness mới. Request hashes/IDs/status chống gửi trùng qua restart, không sao chép transcript vào workspace state. Mất stream báo hoạt động chưa xác định, dừng thinking/timer; reconnect chỉ đọc tiếp cùng phiên, không gửi lại prompt.

Kiểm chứng refinement dùng fixture riêng: viền focus cha/input, kéo và nhả chuột, giới hạn, keyboard reset, resize desktop và mobile, không gọi agent thật. Các kiểm tra native chat vẫn bao phủ thinking/phản hồi/reconnect. Smoke GTK/WebKit dùng adapter synthetic; screenshots tại `apps/andrew-brain/.impeccable/review/refinement-*.png`.

## Đổi tên và điều khiển cấu hình phiên — 10/11/2026

`AgentPicker.tsx` có chuột phải/Shift+F10 → Edit tên phiên và bút chì. POST `/api/workspace/agents/name` kiểm Origin/intent và đúng live terminal incarnation/workspace, gọi Orca terminal rename qua stdin/in-memory CLI rồi lưu nhãn cục bộ theo binding. Tên không được dùng để chọn agent, native session ID và outbox/bản nháp không đổi khi rename.

`codex-conversation.mjs` lọc thêm metadata token_count cho thanh Context ngay trên composer: last_token_usage.total_tokens/model_context_window, thời gian native sample; compact/model-change xóa mẫu cũ. Unknown và mất nguồn không thành số 0 hoặc tiến độ hoàn thành.

`CodexControls.tsx` đặt ba select quyền/model/tốc độ dưới textarea. GET `/api/workspace/chat/settings` cần intent và verified chat ID/binding; `codex-controls.mjs` kiểm native version/catalog và `codex-runtime.py` chỉ đọc row SQLite trùng ID/cwd/rollout_path, không đọc transcript/private text từ DB. POST cùng route nhận action/value whitelist, request ID và confirm rõ ràng; native turn phải idle và không còn prompt/config chưa đối chiếu. Gửi inline `/model`, `/model --speed=...`, `/permissions ...` qua Orca đúng terminal, không ghi config.toml hoặc resume thread vào harness khác.

Ledger controlRequests giữ ID/digest/action/value/state riêng, không phát lại sau reconnect/restart; GET settings đối chiếu model/quyền với metadata, tier với native event. Pending permission/unconfirmed input khóa gửi chat; người dùng xử lý confirmation native trong Orca rồi tải lại. Nút Đã kiểm tra trong Orca chỉ ghi nhận người dùng đã đối chiếu, không đổi quyền hoặc trả lời native approval.

## Luồng Thư viện Brain được giữ lại

## Mục tiêu và thao tác

Andrew mở thư viện, lọc theo nhóm hoặc cá nhân/ví dụ/template, tìm kiếm tiếng Việt có/không dấu, mở note và chọn tối đa8nguồn. Desktop giữ rail trái, list/search phía trên reader và panel trợ lý bên phải. Mobile chia Nguồn/Đọc/Trợ lý; giữ source selection/draft khi đổi tab. Ctrl/Cmd+K đưa focus về tìm kiếm; Escape đóng danh mục hoặc phần yêu cầu kết nối.

Nút Tải lại nguồn đọc snapshot mới. Khi một note khác hash đang chọn, reader báo nguồn thay đổi và cho Tải bản mới; không âm thầm lấy phiên bản mới làm bằng chứng cũ. Nhãn provider chưa kết nối luôn hiện; phần cấu hình giải thích bước còn thiếu. Draft chỉ lưu tạm trong tab, nút gửi disabled, không có response giả.

## Luồng và file

1. `src/BrainLibrary.tsx`, `src/types.ts` gọi GET `/api/notes` qua cùng origin. Search debounce220ms; mỗi request có AbortController/generation, request cũ khi đổi filter/page bị bỏ.
2. `server/index.mjs` nhận GET, kiểm Host/Origin loopback, gọi `server/brain-reader.mjs`; các phương thức ghi của API ghi chú trả405. Không proxy các endpoint của TS Management hoặc provider.
3. Reader đi qua8folder allowlist của `/home/avada/avada-brain`, bỏ README, dotfiles/private/secrets/credentials/auth/logs/sessions/memories/keys/tokens và symlinks. Frontmatter private/sensitive bị loại. Chỉ đọc file .md tối đa1MiB, lỗi một file làm `complete=false` kèm issues; không cắt source âm thầm.
4. Frontmatter YAML safe parser lấy title/type/tags và warning. YAML lỗi vẫn trả nội dung gốc để đọc. Hash nguyên raw UTF-8, ID theo path, index revision theo các ID/hash. Cursor gắn query/filter/limit/revision; mismatch409.
5. Ví dụ được nhận diện theo marker trong tên hoặc field example. `server/template-origin.json` chỉ chứa path/hash của2guide public và URL/commit template; bytes khớp mới là reference. Không coi mọi Markdown là note cá nhân hay khẳng định tác giả từ category.
6. GET `/api/notes/:id?sourceHash=...` trả body/metadata và wikilinks có target duy nhất trong allowlist. SourceHash khác trả409; thiếu nguồn404. API không nhận arbitrary file path.
7. ReactMarkdown+GFM không rawHTML; URL nguy hiểm không thành link, ảnh từ xa không tự tải. Code giữ nguyên nội dung, có cuộn ngang. Selection giữ ID/path/hash; source khác sau refresh/read được đánh dấu, không trộn câu trả lời giữa note.
8. GET `/api/provider` chỉ trả configured=false và yêu cầu thiết lập. API trợ lý theo nguồn chưa có POST chat hay inference; chat Workspace là luồng riêng ở trên. Không tự training, gửi ticket/Slack/Telegram, dùng Hermes hoặc git sync.

`src/styles.css` giữ dark tokens, density và focus state. Đường chạy thường dùng Node phục vụ `dist/` và `/api` ngay5191; Vite5191/API5190 chỉ còn là lựa chọn development khi đã dừng service riêng này. Config dự án và dependency/lock chỉ trong app. Không sửa root package, web/app, chrome-extension, controller/History/Analytics.

## Dữ liệu và quyền

- Brain là nguồn đọc bên ngoài app, không bulk-copy vào repo. Chỉ local OS user có quyền đọc file; app không tạo account/PIN hoặc mở LAN. Đây không phải sandbox chống toàn bộ process cùng OS user.
- Không source writes, không save note/rename/delete/commit/push. Selection/draft ở React memory, không localStorage/DB. Ngoài artifacts build/test, Workspace ghi checklist và request metadata vào state app riêng, không ghi Brain.
- Fixture mode chỉ trên server test có `BRAIN_FIXTURE=1`; UI gắn “Dữ liệu minh họa”. Captures không dùng notes thật.
- Git history brain giữ main395f784ad16385670e7d98ed30bbe9a777f5ecb3 và backupbranch local-initial-20261105. Luồng đọc Brain không gọi Git; cây file Workspace dùng Git chỉ đọc để liệt kê source.
- Chuẩn bị provider thật là bước riêng: chốt provider/model/auth và no-action contract; secret server-only; smoke có duyệt. Không dùng auth Codex hiện có qua endpoint unsupported.

## Cài/chạy/dừng

Unit `~/.config/systemd/user/andrew-brain.service`; bản sao để bảo trì tại `apps/andrew-brain/systemd/andrew-brain.service`. `WorkingDirectory` đúng app, `ExecStart=/usr/bin/node` với `server/index.mjs`, `PORT=5191`, `UI_PORT=5191`, brain root cố định. API bind127.0.0.1; server đã có graceful SIGTERM.

Dùng `systemctl --user start|stop|restart|status andrew-brain.service`; đọc log bằng `journalctl --user -u andrew-brain.service -n 40 --no-pager`. Unit enabled ở user default.target, Restart=on-failure/3s; tự chạy theo user login, không theo terminal agent. `Linger=no` giữ nguyên nên không đảm bảo chạy trước login/sau phiên user cuối cùng hoặc24/7. Không system service/sudo, không cùng cgroup với Andrew TS. Không restart5088/5077/notifier.

Source đổi thì build riêng app bằng `npm run build` rồi restart service riêng; không reinstall dependencies khi đã có đúnglock. Chạydev thủ công cần stop service trước vì Vite dùng cùng5191; đây không phải đường sử dụng thường. PID preview05/11 là lịch sử, không dùng để kill PID tái sử dụng.

## Kiểm chứng và giới hạn

Logic tests kiểm Unicode/hash/pagination/revision, source đổi, private/symlink/traversal, YAML lỗi, code80KB, file quá1MiB, wikilink, Host/Origin/write rejection và exact template provenance. Browser matrix desktop1440/mobile390 kiểm real fixture API/search/selection/reader, keyboard, pagination, XSS/unsafe media, long code, stale response, conflict refresh, loading/offline/empty, no writes. Screenshot/review trong app `.impeccable/review`; evidence logs/baseline trong `runtime/agent-artifacts/brain-app-build-20261105`.

Selected-source freshness chỉ được kiểm khi có lượt đọc/refresh, không watch filesystem nền. Chưa cấu hìnhAI, chưa live inference, chưa note-edit hoặc sync. File ngoài allowlist/private không xuất hiện; file quá giới hạn hoặc lỗi đọc có notice completeness. UI không tuyên dữ liệu legacy/template là tác phẩm của người dùng. Review verdict và DESIGN/tokens được ghi sau finish review, không lấy build pass thay verdict.

## Nghiệm thu build 05/11/2026

Logic8/8, browser matrix10/10 và các lượt targeted cho thay đổi/fix đều pass. TypeScript/Vite build pass. Detector chạy1lần, một warning Arial được reviewer chấp nhận trong Operate workhorse UI; không chạy detector lần hai. Finish review ban đầu disposition fix với2finding; verdict pass chấm cả2resolved và ship ở phạm vi các finding đó. Không diễn giải thành audit toàn app mới. DESIGN.md và sidecar schemaVersion2 do shipped documenter ghi từ code đã built.

Live GET cuối:9nguồn trong allowlist =1ghi chú cá nhân,6ví dụ mẫu,2guide template khớp provenance; không phải17Markdown là17note cá nhân. Source hashes khớp file gốc và snapshot đọc trước đó, brain Git HEAD/status không đổi. Preview chỉ127.0.0.1:5190/5191; providerConfigured=false. Vite deny phục vụ PRODUCT/DESIGN/.impeccable/server/tests/.runtime qua HTTP để không đưa development contract ra browser; Node bản build chỉ phục vụ index/assets.

BOM UTF-8 không che được private frontmatter; invalid UTF-8 bị loại với completeness notice, không thay ký tự âm thầm. Mobile tabs có roving tabindex và Left/Right/Home/End; Ctrl/Cmd+K focus sau khi đổi vùng. Nút xem nguồn trên desktop chuyển focus thật; offline nêu dịch vụ/lệnh/APIport và nút Thử lại. API task có SIGTERM đóng server; không tác động dịch vụ project cũ.

## Sửa truy cập — 06/11/2026

Ảnh báo ERR_CONNECTION_REFUSED tại5191. Preflight: cả5190/5191 không có listener; các PID preview05/11 không tồn tại, host boot mới lúc03:51:31 UTC+7 ngày06/11; không có unit Andrew Brain. Logs chỉ ghi startup/dev allowlist trước reboot, không có crash receipt chứng minh lỗi provider/firewall. Nguyên nhân quan sát được là preview tạm không được khởi động lại sau boot, không có cơ chế autostart.

Đã tạo/enable/start dedicated user service, phục vụ production build+API cùng5191. URL/routes giữ nguyên, UI dark/sources và providerOPEN giữ; chỉ sửa recovery copy offline và assertion liên quan để chỉ đúng service mới. Build app-local một lần; không reinstall, không chạy suite thiết kế không liên quan.

HTTP200 index/JS/CSS/health/notes/search/detail; sourceHash của guide public khớp disk. Các đường source/doc/private trả404. Browser Chrome cô lập tại URL thật desktop1440 và mobile390 render đúng, đọc guide từ template, không console error/request failure/response4xx, không screenshot note riêng. AI chưa kết nối và nút gửi vẫn disabled. Hash17Markdown trong phạm vi baseline, brain HEAD/branch/status đối chiếu trước/sau. Chưa kiểm bằng reboot host thật; persistence được xác minh bằng enabled unit + user manager/cgroup + Restart policy, không giả nghiệm thu24/7.

Evidence/backup: `runtime/agent-artifacts/brain-access-fix-20261106/`.

## Thay đổi

- 10/11/2026: Viền focus ô thêm việc khớp toàn khung; thêm separator kéo/co giãn checklist–chat và điều khiển bàn phím theo ảnh `Zmug4QPQxAnS`. Cập nhật mô tả Workspace và chat Codex local qua Orca hiện hành; luồng Thư viện Brain vẫn chỉ đọc.

- 10/11/2026: Thêm nút thùng rác xóa từng task theo ảnh `k0YZwFY8LdiF`, endpoint DELETE có intent/Origin và ghi nguyên tử; kiểm thử chỉ dùng task fixture.

- 10/11/2026: Thêm Edit/pencil đổi tên tab, context đã dùng/tổng trên composer, select quyền/model/Fast phía dưới input; binding/dedupe và native confirmation được giữ.
