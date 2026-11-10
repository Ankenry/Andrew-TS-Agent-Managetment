# Andrew Brain

## Bố cục Workspace — 10/11/2026

Màn chính theo ảnh Đại tá cung cấp `https://capture.avada.io/i/g4MUCONkt8Ra`: Work Space ở rail trái; agent ở thanh trên; checklist giữa trái; chỉ thị cho agent giữa phải; cây folder/file ngoài cùng bên phải. Trên màn nhỏ, dùng các tab Công việc/Giao việc/Files; ArrowLeft/Right, Home/End và Ctrl+K hỗ trợ bàn phím. Thư viện ghi chú cũ nằm ở nút **Thư viện Brain**.

- Checklist được lưu riêng tại `~/.local/state/andrew-brain/workspace.json`, không sửa note hay status Helpdesk. Cập nhật giữa reader desktop và web được khóa và ghi nguyên tử.
- Folder/file lấy từ project hiện tại theo Git, gồm thay đổi chưa commit; loại file bí mật, dotfiles, dữ liệu runtime, dependency và build. Preview chỉ đọc, tối đa 256 KB, không theo symlink hay đường dẫn ra ngoài workspace.
- Agent strip lấy metadata Orca đã xác minh trong đúng workspace. Khi chọn agent Codex, chat ràng buộc terminal handle, process incarnation, workspace và native session ID của chính process đang chạy. Không mở một Codex thứ hai hoặc thay account/model/permissions.
- Chat hai chiều đọc các message công khai từ hội thoại Codex local đang mở của agent đó: câu hỏi, câu trả lời và cập nhật tiến độ. Bộ lọc loại bỏ raw reasoning, system/developer messages, tool arguments/results và subagent sessions. Trạng thái **Đang suy nghĩ / Đang xử lý / Đang trả lời** và thời gian lấy từ lượt thực; không hiển thị suy nghĩ nội bộ.
- Chỉ gửi khi người dùng bấm **Gửi tin nhắn** (hoặc Ctrl+Enter). Nội dung được đưa qua stdin vào Orca CLI trong bộ nhớ; không nằm trong OS argv hay biến môi trường. Mở app, chọn agent hoặc kết nối lại không tự gọi model hay gửi prompt.
- Request ID và hash chống gửi trùng cả sau khi reader khởi động lại. Biên nhận input khác với kết thúc lượt trả lời. Mất kết nối không được coi là hoàn thành; kết nối lại chỉ đọc tiếp, không gửi lại. Native session đổi cần người dùng chọn lại agent.
- Lịch sử nội dung vẫn nằm tại Codex; app giữ nội dung hiển thị trong bộ nhớ và lưu riêng hash/ID/trạng thái của request tại workspace state, không sao chép transcript. Lượt chưa rõ kết quả bị chặn gửi lại; người dùng có thể đối chiếu Orca rồi xác nhận đã kiểm tra.

API đọc `/api/workspace` và `/api/workspace/file`; chat `/api/workspace/chat` và `/api/workspace/chat/events` cần intent của cửa sổ, stream NDJSON chỉ chứa hội thoại công khai. POST checklist/tin nhắn cần đúng Origin, JSON và intent. Vault API vẫn chỉ đọc, AI theo nguồn vẫn chưa kết nối. Cấu hình workspace desktop được installer ghi tại `~/.local/opt/andrew-brain/desktop/workspace.json`; không sao chép vault hoặc credentials.

## Ứng dụng desktop — 10/11/2026

Mở **Andrew Brain** bằng icon dưới Home trên desktop hoặc tìm trong danh sách ứng dụng. Bản Linux dùng cửa sổ GTK 3 và WebKitGTK riêng, không mở tab Chrome. Mỗi lần mở app tự khởi động reader chỉ đọc trên một cổng loopback riêng; đóng cửa sổ thì reader dừng. Bấm icon lần nữa đưa cửa sổ hiện có lên trước.

```sh
npm run desktop:install
npm run desktop
npm run test:desktop
```

Bộ cài build React production, chép UI, reader và dependency `yaml` vào `~/.local/opt/andrew-brain`, rồi đăng ký `com.ankenry.AndrewBrain.desktop` tại `~/.local/share/applications` và thư mục Desktop được `xdg-user-dir` xác định. Dữ liệu `/home/avada/avada-brain` không được sao chép vào bộ cài. Máy cần `/usr/bin/node` từ 20.19, `/usr/bin/python3`, PyGObject, GTK 3 và WebKit2 4.1; máy triển khai hiện đã có các dependency này.

Reader desktop độc lập với service web cổng 5191. WebKit dùng bộ nhớ phiên riêng, không dùng profile Chrome; sandbox bật, không có Node bridge cho UI, điều hướng trong app chỉ đến đúng origin reader. Link HTTP/HTTPS do người dùng chọn mở bằng ứng dụng mặc định. Chat Codex local qua Orca đã kết nối; trợ lý AI theo nguồn trong Thư viện Brain vẫn chưa cấu hình. App không ghi vào vault hay tự đồng bộ Git.

Kiểm tra cửa sổ desktop với dữ liệu synthetic, không chụp ghi chú thật:

```sh
/usr/bin/python3 desktop/andrew_brain.py --smoke-test
```

Lệnh này dùng riêng `tests/fixtures/vault`, kiểm tra UI thực trong WebKit và lưu ảnh tại `.runtime/desktop-smoke/native-window.png`. Trạng thái cửa sổ thật nằm ở `~/.cache/andrew-brain/desktop-status.json`, không chứa nội dung ghi chú. Phần chạy web local bên dưới vẫn có thể dùng riêng khi cần.

App cá nhân web local: đọc/tìm ghi chú Markdown và chọn nguồn cho câu hỏi. Giao diện **Nguồn cạnh câu hỏi**, dark/developer. **AI theo nguồn chưa kết nối** trong Thư viện Brain; chat agent ở Workspace dùng phiên Codex local qua Orca riêng biệt.

## Chạy local — service từ 06/11/2026

URL giữ nguyên: **http://127.0.0.1:5191/**. Một Node process phục vụ `dist/` và `/api/*` cùng origin trên5191; không còn phụ thuộc Vite hoặc API5190 cho đường chạy thường.

```sh
systemctl --user status andrew-brain.service
systemctl --user start andrew-brain.service
systemctl --user stop andrew-brain.service
systemctl --user restart andrew-brain.service
journalctl --user -u andrew-brain.service -n 40 --no-pager
curl http://127.0.0.1:5191/api/health
```

Unit `~/.config/systemd/user/andrew-brain.service`, source copy `systemd/andrew-brain.service`; Node `/usr/bin/node`, cwd app, `PORT=5191`, `UI_PORT=5191`. `Restart=on-failure`, enabled dưới user `default.target`: tự chạy cùng user manager khi đăng nhập. `Linger=no` giữ nguyên; không hứa host24/7 hoặc chạy khi chưa login. Process do systemd user quản lý, không phụ thuộc terminal Codex. Không system service/sudo/LAN/tunnel, không ghép cgroup TS Management/Trace.

Nếu sửa source: dùng dependency app-local đã pin, `npm run build` rồi restart đúng `andrew-brain.service`. Bản build chỉ phục vụ index/assets; PRODUCT/DESIGN/.impeccable/server/tests/.runtime và file bí mật không được phục vụ.

### Chế độ development tùy chọn

Node20.20.2 hiện có, dependency pin trong lockfile. Dừng service Andrew Brain trước khi dùng lại port5191, rồi trong thư mục app chạy riêng `npm run api` (5190) và `npm run dev` (Vite5191 proxy về5190). Không cần development mode để người dùng mở app. PID preview cũ trong `.runtime/preview-processes.json` là lịch sử05/11, không được dùng để kill process hiện tại; runtime mới ở `.runtime/service-status.json` và `systemctl --user show`.

## Dữ liệu và giới hạn

- Mặc định đọc `/home/avada/avada-brain`. `BRAIN_ROOT` là cấu hình server, không nhận đường dẫn từ browser.
- Allowlist: `00-inbox`, `01-to-do`, `10-daily`, `20-meetings`, `30-projects`, `50-learning`, `60-guides`, `70-decisions`. Chỉ Markdown, bỏ README, dotfiles, private/secrets/auth/logs/session/memory/credential/key folders và symlink. Frontmatter `private: true` hoặc `sensitivity: private|secret|confidential` không được index.
- Ví dụ có dấu sample/example/template/mẫu hoặc `example: true` được gắn nhãn. Hai guide public từ template chỉ được nhận diện “Từ template” khi path+SHA256 khớp manifest có commit nguồn; thay nội dung thì không còn nhận diện như bản template nguyên vẹn. “Ghi chú cá nhân” là nhóm còn lại trong vault cá nhân, không chứng minh tác giả.
- Source ID ổn định theo relative path; `sourceHash` theo nguyên byte nội dung UTF-8; revision/cursor gắn snapshot. Ghi chú quá 1 MiB không bị cắt: API báo index chưa đầy đủ. Không có background scan; tải khi GET hoặc người dùng bấm tải lại.
- Markdown không render HTML thô. Image ngoài không tự tải; link http/https chỉ mở khi người dùng chọn, có noopener/noreferrer. Wikilink được hiển thị kèm danh sách nguồn liên quan, chỉ mở target duy nhất trong allowlist.
- Source selection và draft của thư viện Brain chỉ ở bộ nhớ tab, mất khi reload; tối đa 8 nguồn. Không ghi vào brain, không git commit/push, không DB hoặc migration. Các route vault/provider chỉ nhận GET; phương thức ghi trên các route này trả 405. POST riêng của Workspace tuân theo quyền chủ động và intent mô tả ở trên. Host/Origin ngoài allowlist bị từ chối.
- Đây là read-only boundary của app local, không phải OS sandbox chống người có cùng quyền tài khoản sửa filesystem đồng thời. `realpath/lstat/O_NOFOLLOW` và revision checks giảm lỗi traversal/race thông thường; không hứa atomic CAS với mọi chương trình ngoài app.

## AI theo nguồn trong Thư viện Brain còn cần gì?

Người dùng chưa chọn provider/model/auth. Chọn một API hỗ trợ text-only/no-action tools, cấu hình credential chỉ ở server, kiểm quyền và thực hiện smoke được duyệt trước khi nối UI. Không dùng OAuth Codex như bearer cho endpoint tự suy đoán, không fallback generic agent/TS Elite/Hermes. Hiện chỉ `/api/provider` trả trạng thái và hướng dẫn; nút gửi disabled có lý do, không trả lời mô phỏng.

## Kiểm tra

```sh
npm test
npm run build
npm run test:browser
```

Browser test dùng Chrome có sẵn, profile cô lập, server ephemeral và vault synthetic trong `tests/fixtures/vault`. Chặn request ngoài app fixture; không gọi AI/Helpdesk. Captures ở `.impeccable/review/`, không chứa note riêng. Dữ liệu test `.runs` được giữ local và gitignored; không tự xóa artifacts.

`BRAIN_FIXTURE=1` chỉ gắn nhãn fixture khi chạy test; không dùng nó để gọi dữ liệu thật là minh họa. Thư mục brain thật không được dùng để chụp ảnh kiểm thử.

## Kiểm chứng chat Codex local — 10/11/2026

Backend kiểm binding terminal/process/workspace/session, loại nội dung riêng, UTF-8 từng phần, mất nguồn và chống gửi trùng qua restart. Browser fixture kiểm lịch sử, thinking trước câu trả lời, nhận phản hồi, reload/reconnect và đổi nguồn. Smoke WebKit thật gửi vào adapter synthetic và kiểm đã thấy thinking rồi nhận phản hồi; không gửi lệnh thử tới agent thật. Đối chiếu agent thật chỉ đọc lại câu hỏi/câu trả lời có sẵn.

Transport gửi là Orca CLI; đường nhận là reader của public messages trong structured session file mà đúng native Codex process đang mở. Đây không phải một app-server Codex mới hay provider API mới. Nếu phiên chưa mở, không phải Codex hoặc binding không xác minh được, chat báo lỗi và không tự thay bằng agent khác.

## Điều chỉnh khung làm việc — 10/11/2026

Theo ảnh `https://capture.avada.io/i/Zmug4QPQxAnS`, focus của ô Thêm công việc bao quanh cả khung, gồm icon và nút thêm; input không có vòng focus riêng bên trong. Kéo thanh chia có tay nắm giữa checklist và chat sang trái/phải để đổi độ rộng. Có thể Tab tới thanh chia, dùng ←/→ (Shift để đổi nhanh), Home/End tới giới hạn, Enter hoặc double-click để chia đều. Tỷ lệ giữ trong cửa sổ hiện tại; không sửa dữ liệu checklist hay phiên agent. Desktop giữ checklist tối thiểu 280px và chat 320px khi đủ chỗ; cửa sổ hẹp tự giới hạn khoảng kéo, mobile vẫn dùng các tab.

## Xóa task — 10/11/2026

Mỗi dòng checklist có nút thùng rác **Xóa công việc** ngay cạnh nút đưa vào chat, theo ảnh `https://capture.avada.io/i/k0YZwFY8LdiF`. Bấm nút xóa đúng task đó khỏi checklist đang lưu trên máy, cả task cần làm và đã hoàn thành. Trong lúc chờ, task được khóa thao tác; xóa thành công cập nhật bộ đếm và thông báo. Nếu lỗi, task vẫn hiện; thông báo hướng dẫn bấm thùng rác để thử xóa lại. Nút Tải lại checklist chỉ đọc lại danh sách và đóng lỗi, không tự xóa. Thao tác không xóa note, source hay tác vụ của agent.

## Tên phiên, context và cấu hình Codex — 10/11/2026

- Đổi tên: bấm bút chì trên chip agent, hoặc chuột phải → **Edit tên phiên** (bàn phím: Shift+F10). Nhập tên, bấm Lưu tên hoặc Hủy/Escape. Tên được đồng bộ bằng Orca terminal rename và lưu nhãn theo đúng workspace/terminal/incarnation; tên không dùng để định tuyến agent hay đổi vai trò phiên. Đổi tên giữ nguyên native chat và bản nháp.
- Context: thanh **đã dùng / tổng tokens** nằm ngay trên composer, lấy `token_count.info.last_token_usage.total_tokens` và `model_context_window` của native session. Không lấy tổng token cộng dồn hay đếm ký tự. Khi compact hoặc model đổi, chờ mẫu mới; mất kết nối giữ mẫu cuối có nhãn. Không có mẫu thì ghi Chưa có số liệu.
- Dưới ô chat có Quyền, Model và Tốc độ. Danh sách model đọc catalog local của đúng Codex home; trạng thái model/quyền đọc metadata SQLite chỉ đọc của đúng session/path, service tier chỉ hiện khi được native session báo. Inline controls cần Codex 0.167 trở lên. Unknown/unsupported được hiển thị rõ, không đoán model/quyền/Fast.
- Người dùng chọn thì app gửi lệnh inline có cấu trúc qua Orca vào đúng phiên: `/model <id>`, `/model --speed=standard|priority`, `/permissions <profile-id>`. Không tự đổi cấu hình khi mở app; không sửa config.toml hay mở Codex thứ hai. Fast dùng session-only model speed, không gọi toggle `/fast` để tránh thay mặc định chung.
- Chờ lượt đang chạy kết thúc trước khi đổi cấu hình. Input acceptance khác với đã áp dụng. Request có ID chống lặp; khi còn chờ, app đối chiếu metadata/stream. Nếu Codex hỏi xác nhận quyền thì người dùng xử lý tại Orca, app không tự bấm/đáp approval. Chưa rõ quyền hoặc delivery thì chặn gửi tiếp; sau khi đối chiếu có nút Đã kiểm tra trong Orca. Nối lại không tự gửi lại cấu hình.

Kiểm thử điều khiển dùng adapter/catalog/runtime synthetic. Đối chiếu phiên thật chỉ đọc binding, catalog, runtime metadata và token counts; không tự đổi model, quyền, speed hoặc tên agent thật để thử.
