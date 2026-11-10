# Andrew Brain

App cá nhân web local: đọc/tìm ghi chú Markdown và chọn nguồn cho câu hỏi. Giao diện **Nguồn cạnh câu hỏi**, dark/developer. **AI chưa kết nối**: không có model response hoặc endpoint gọi AI trong phiên bản này.

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
- Source selection và draft chỉ ở bộ nhớ tab, mất khi reload; tối đa 8 nguồn. Không ghi vào brain, không git commit/push, không DB hoặc migration. Các route đều GET; mọi phương thức ghi trả 405. Host/Origin ngoài allowlist bị từ chối.
- Đây là read-only boundary của app local, không phải OS sandbox chống người có cùng quyền tài khoản sửa filesystem đồng thời. `realpath/lstat/O_NOFOLLOW` và revision checks giảm lỗi traversal/race thông thường; không hứa atomic CAS với mọi chương trình ngoài app.

## AI còn cần gì?

Người dùng chưa chọn provider/model/auth. Chọn một API hỗ trợ text-only/no-action tools, cấu hình credential chỉ ở server, kiểm quyền và thực hiện smoke được duyệt trước khi nối UI. Không dùng OAuth Codex như bearer cho endpoint tự suy đoán, không fallback generic agent/TS Elite/Hermes. Hiện chỉ `/api/provider` trả trạng thái và hướng dẫn; nút gửi disabled có lý do, không trả lời mô phỏng.

## Kiểm tra

```sh
npm test
npm run build
npm run test:browser
```

Browser test dùng Chrome có sẵn, profile cô lập, server ephemeral và vault synthetic trong `tests/fixtures/vault`. Chặn request ngoài app fixture; không gọi AI/Helpdesk. Captures ở `.impeccable/review/`, không chứa note riêng. Dữ liệu test `.runs` được giữ local và gitignored; không tự xóa artifacts.

`BRAIN_FIXTURE=1` chỉ gắn nhãn fixture khi chạy test; không dùng nó để gọi dữ liệu thật là minh họa. Thư mục brain thật không được dùng để chụp ảnh kiểm thử.
