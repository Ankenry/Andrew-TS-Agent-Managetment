# Cách ly môi trường terminal của Codex trong Orca

## Mục đích và phạm vi

Mỗi agent giữ nguyên session, tab và workspace được giao. Môi trường của lệnh
tool phải mang `ORCA_TERMINAL_HANDLE` của chính tab đó. Không sửa biến bằng tay
để làm kết quả điểm danh trông đúng, không tạo session thay thế và không đổi
quyền sandbox, model hoặc telemetry.

## Chẩn đoán ngày 2026-10-29

Máy dùng Codex CLI 0.165.0. Tiến trình TUI Hanski PID 145390 có handle đúng
`term_71726b1f-afb1-4bec-a1b2-984142550da4`, nhưng tool của session
`01a186b9-6a09-7810-801b-0f5904e4183e` nhận
`term_b98c8fd9-e2e1-49d2-bd9e-6dae20b99871`.
Backend chung PID 10831 là con của TUI Hachimi PID 10779 và kế thừa handle
Hachimi. Các TUI khác có handle riêng đúng lúc khởi chạy.

`~/.bashrc` chứa `alias codex='cc codex'`; `~/.local/bin/cc` gọi binary Codex.
Đường gọi này bỏ qua shell function của Orca, vốn bổ sung `--no-daemon` để
cách ly backend. Mã Orca cài trên máy xác nhận vấn đề chia sẻ môi trường của tab
đầu tiên trong `out/shared/codex-shell-function.js` và đề xuất tắt
`daemon_auto_start` trong `out/shared/codex-shared-server-command.js`.
PID và đường mount AppImage chỉ là bằng chứng tại thời điểm chẩn đoán;
phải đọc lại khi thao tác, không dùng để kill tiến trình về sau.

## Cấu hình đã áp dụng

Sau khi Hanlead duyệt bước 1–2, thêm duy nhất dòng sau vào `[features]` trong
`/home/avada/.codex/config.toml`:

```toml
daemon_auto_start = false
```

Bản sao trước thay đổi:
`/home/avada/.codex/config.toml.hanski-daemon-backup-20261029T082835577839Z`.
SHA-256 bản sao: `a678b7e281cb5f1093864853c10f8891f49a1b98f99d3be7ebaf9695e0240987`.
SHA-256 sau thay đổi: `36c19e4500cda6858dafe4000cda504647942dd55599229cf0fac3fa7f20e1b8`.
Đã so sánh TOML trước/sau: các giá trị khác giữ nguyên; mode `0600` giữ nguyên.
Không in nội dung cấu hình hoặc backup vì chúng có thể chứa credential.

Kiểm tra cấu hình cho lần khởi chạy sau:

```bash
codex features list | rg '^daemon_auto_start'
```

Giá trị đã đọc lại: `stable false`. Cấu hình không chuyển các TUI đang chạy
ra khỏi backend cũ. Không dùng kết quả này để kết luận các agent hiện tại đã sửa.

## Kích hoạt theo từng tab

1. Lấy metadata sống từ Orca: tên tab do người dùng đặt, handle, workspace,
   session ID và trạng thái idle từ nguồn có thẩm quyền. Lọc preview, summary,
   history và tool streams khỏi output. Không suy ra session từ tên hội thoại.
2. Giữ Hanlead và Hanski hoạt động trong suốt thử nghiệm hai worker đầu tiên.
   Chưa dừng backend chung. Chỉ thoát TUI của worker đã xác minh idle và được
   đưa vào đợt chuyển. Không đóng tab shell, không gửi lệnh launch khi TUI chưa thoát.
3. Resume đúng UUID trong chính tab shell đó, giữ thư mục làm việc:

```bash
cc codex --no-daemon resume <UUID-da-xac-minh> -C '/home/avada/Andrew Tools CS-TS/Andrew TS Tools'
```

Không dùng `--last`, `fork`, session mới, `--remote`, hoặc cờ đổi quyền/model.
`--no-daemon` được CLI 0.165.0 mô tả là không dùng backend chung ngay cả khi
backend ấy vẫn chạy. Việc dùng `cc` tiếp tục đi qua wrapper telemetry hiện tại.
4. Mỗi worker chạy phép kiểm dưới đây bằng tool shell của chính nó và gửi FINAL.
   Đối chiếu thêm process metadata trên host: TUI/backend riêng kế thừa handle
   đúng. Hai worker phải có handle khác nhau đúng với hai tab; cả hai giữ UUID cũ.
5. Chỉ sau khi hai phép kiểm thật và đường báo cáo thành công mới chuyển các
   agent còn lại. Handoff vai trò điều phối trước khi chuyển Hanlead/Hanski;
   không restart chúng trong lúc đang làm việc. Không cần stop backend chung
   để ép các launch `--no-daemon` cách ly.

## Kênh phối hợp và biên nhận

`send_message_to_thread` hiện hoạt động giữa các session trên backend chung.
Chưa xác nhận nó hoạt động xuyên backend riêng. Không gửi qua backend cũ vào
UUID đã chuyển nếu chưa xác minh tuyến: có thể đánh thức bản session trên
backend cũ thay vì tab đã chuyển.

Orca cung cấp `terminal send --terminal <handle> --text <text> --enter --json`
để gửi vào đúng terminal sống, độc lập với việc các Codex có chung backend.
`--wait-submit <seconds>` quan sát submission, không tự gửi lại. Đường này cần
kiểm chứng bằng FINAL của worker về đúng Hanlead trước khi coi là kênh thay thế
đã hoạt động. Acceptance hoặc provider `unsupported` không phải bằng chứng
worker đã nhận/xử lý. Khi kết quả không rõ, giữ request ID, đối chiếu biên nhận;
không gửi lại như request mới. Không đọc thinking, history hoặc tool stream.

Orca CLI trong sandbox không thấy PID host nên có thể báo unavailable. Với
lệnh cần thiết, dùng approval chính thức cho lệnh host; không thay permissions
hay sửa shim để né sandbox.

## Kiểm chứng

`scripts/check-orca-codex-binding.py` chỉ đọc cwd và ba biến định danh. Tham số
expected chỉ để so sánh; script không inject env hay ghi file. Chạy bằng tool
`exec_command` trong từng agent sau resume, không chạy thay từ shell của Hanski.

```bash
python3 scripts/check-orca-codex-binding.py --session <UUID> --handle <handle> --workspace '/home/avada/Andrew Tools CS-TS/Andrew TS Tools'
```

Exit 0 chỉ khi cả `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, handle và workspace
đều khớp. Exit 1 và trường `mismatches` nêu sai lệch. Output không có secret.
Kiểm thử bằng fixture chỉ kiểm tra comparator; không thay thế phép kiểm trên
hai tool environment thật. Mỗi FINAL phải ghi rõ kết quả thực tế và trạng thái
cấu hình cho lần mở mới so với adoption của session đang chạy.

## Khôi phục

Nếu cấu hình mới gây lỗi, dừng chuyển thêm worker, giữ coordinator cũ hoạt động.
Đối chiếu checksum/config hiện tại trước mọi khôi phục để tránh đè thay đổi của
người khác. Có thể đổi riêng `features.daemon_auto_start` thành `true` theo
phạm vi rollback được duyệt; không xóa file hoặc các thiết lập khác. Backup giữ
nguyên, không cleanup tự động. Bật lại backend chung cũng có thể tái tạo lỗi
handle; không coi là khôi phục binding đúng.

Nếu worker đã thoát nhưng không resume được, chỉ retry đúng UUID trên đúng tab
sau khi xác minh không còn instance chạy. Không chạy song song UUID trên hai
backend. Nếu chưa có đường phối hợp tin cậy, báo blocker để Hanlead quyết định;
không tự tạo coordinator/session thay thế.

## Nguồn và thay đổi

- Bằng chứng chính: CLI và mã Orca cài trên máy, metadata tiến trình đọc ngày
  2026-10-29; không dùng history của agent.
- [Tài liệu cấu hình OpenAI](https://learn.chatgpt.com/docs/config-file/config-reference)
  mô tả chính sách kế thừa môi trường. Không có bằng chứng từ trang này rằng
  sửa một biến môi trường sẽ thay đổi backend đã chạy.
- 2026-10-29: thêm cấu hình ngăn tự dùng daemon chung, script kiểm binding và
  quy trình chuyển/khôi phục. Chưa chuyển session hiện tại; chưa có kết quả
  kiểm chứng hai tab sau resume ở thời điểm viết tài liệu.

### Biên nhận kiểm tra ban đầu

- Comparator: 6/6 ca đạt (khớp, sai riêng từng trường, thiếu toàn bộ trường).
- Tool của Hanski chạy script thật trước resume: exit 1, chỉ sai
  `ORCA_TERMINAL_HANDLE`; session và workspace khớp. Đây là baseline chưa sửa.
- Đã gửi kế hoạch qua Orca vào tab Hanlead
  `term_f6a1a8be-328d-45ea-b99d-3509b3a522e8`, request
  `d32c3ecb-6ed8-4549-99ec-d1a7409f80d2`. Biên nhận ghi
  `input_accepted`, `turn_started`, provider `codex`, observation `supported`.
  Chưa có phản hồi ứng dụng từ Hanlead tại lúc ghi; chưa coi đây là xác nhận
  đường báo cáo xuyên backend riêng. Kế hoạch yêu cầu Hanlead cung cấp hai cặp
  UUID/handle pilot đã xác minh trước khi thoát TUI.

### Pilot Hancom: bị chặn trước resume

Hanlead đã xác nhận nhận kế hoạch qua Orca và duyệt Hancom trước Hancal.
Hancom: UUID `01a186b9-4416-7241-bc45-18a8731bb4bf`, handle
`term_4dd2fd76-8df9-4847-b888-f04c20d6bf8d`, tabId
`855309f0-d4d5-4531-810c-375579a9e2b3`. Trước thao tác, metadata cho biết
terminal writable, không có agentWait; danh sách Codex xác nhận session idle.

Lệnh `/quit` đã làm TUI cũ thoát (PID 143984 không còn). Lần đọc process ngay
sau đó còn thấy shell của tab, nhưng lần gửi lệnh resume chính UUID đã bị
Orca từ chối với `terminal_not_writable`, request ID
`1fab7aef-acf0-4fe2-a8d2-7787af49d9e1`. Metadata Orca sau đó chỉ còn sáu
terminal, không còn handle hoặc tabId Hancom trong visual layout. Vì vậy
không được mặc định `/quit` giữ được tab Orca trên môi trường này.

Chưa có resume thành công, chưa chạy lại request, chưa tạo terminal hay session
thay thế. Hancal chưa bị tác động. Cần khôi phục tab gốc bằng cơ chế Orca được
hỗ trợ, hoặc người dùng cho phép binding terminal mới, rồi mới tiếp tục đúng
UUID. Không được tiếp tục pilot thứ hai trước khi pilot đầu kiểm chứng đạt.

Đã thử gửi blocker qua `send_message_to_thread` về Hanlead; tool từ chối:
`MCP tool call requires approval, but approval policy is never`.
Không xác nhận blocker này đã được chuyển tới Hanlead, không đổi policy hay
đổi kênh để vượt chặn. Giữ Hanlead/Hanski/backend chung; báo tại phiên Hanski.
Trạng thái cuối đợt này: cấu hình cho launch mới đã sửa, adoption của session
hiện tại chưa được chứng minh, không có kết quả hai tool environment thật.
