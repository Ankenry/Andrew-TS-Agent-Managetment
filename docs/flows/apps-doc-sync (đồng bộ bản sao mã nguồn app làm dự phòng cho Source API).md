# APPS-DOC-SYNC — đồng bộ bản sao mã nguồn app làm dự phòng cho Source API

## Mục đích
`apps_doc/` là bản sao mã nguồn các app (tải qua TS Elite 2 `GET /api/v1/code/archive`). Từ 09/10/2026 luồng check-ticket-v2 đọc mã nguồn mới nhất qua Source API và chỉ dùng `apps_doc/` khi API lỗi, nên bản sao chỉ cần tươi theo tuần. Tính năng này giữ bản sao được tải lại mỗi tuần, kể cả khi máy tắt đúng giờ hẹn: lần khởi động agent đầu tiên sau mốc sẽ tự đồng bộ bù.

## Cách kích hoạt
- Hẹn giờ: timer user systemd `andrew-apps-doc-sync.timer` (Chủ nhật 03:30 Asia/Ho_Chi_Minh, `Persistent=true` nên mốc lỡ vì máy tắt sẽ chạy ngay khi phiên user lên lại). Cài: `npm run appsdoc:sync:install` (chỉ ghi unit), bật: `npm run appsdoc:sync:enable`, gỡ: `npm run appsdoc:sync:uninstall`.
- Sync bù khi agent khởi động: hook `SessionStart` trong `.claude/settings.local.json` gọi `node scripts/apps-doc-sync-if-due.mjs`; notifier (`skills/check-ticket/scripts/service.mjs` → `start()`) cũng gọi `startIfDue()`. Cả hai chỉ khởi động sync ở nền khi đã đến hạn.
- Tay: `npm run appsdoc:sync` (chạy ngay, không cần đến hạn), `npm run appsdoc:sync:check` (chỉ in đến hạn hay chưa).

## Luồng từng bước
1. **Tính đến hạn** (`lastDueAt`, `isDue` trong `scripts/apps-doc-sync-if-due.mjs`): mốc gần nhất đã qua = Chủ nhật 03:30 giờ VN gần nhất (tính bằng `Intl` theo múi giờ, không phụ thuộc múi giờ máy). Đến hạn khi chưa có mốc sync, hoặc `last-sync.json.at` cũ hơn mốc đó. Mọi đường sync (timer, tay, bù) đều ghi mốc nên một tuần chỉ sync một lần.
2. **Kiểm tra lúc khởi động** (`startIfDue`): đọc `runtime/apps-doc-sync/last-sync.json`; chưa đến hạn → im lặng, thoát ngay. Đến hạn → nhìn `sync.lock`: lock còn sống (tiến trình còn chạy, dưới 2 giờ) → thoát, báo "đang chạy"; không thì spawn `node scripts/apps-doc-sync-if-due.mjs --run --source catch-up` detached (`unref`, stdio ignore) rồi thoát ngay; hook in một dòng `[apps-doc-sync] … đang đồng bộ ở nền`, notifier log `apps_doc catch-up sync started in background`. Phiên không bị chặn.
3. **Chạy sync** (`runSync`): lấy lock nguyên tử (`O_EXCL`; lock chết/cũ hơn 2 giờ thì chiếm lại), ghi log `runtime/apps-doc-sync/sync-<thời điểm>.log`, chạy `scripts/fetch-app-sources.mjs <21 app>` (joy-subs, air-reviews, aem, shopvid, booking, order-limits, cookie-bar, pdf-invoice, survey, accessibility, age-verification, air-edd, order-tracking, affily, fraud-filter, online-course, shipping-labels, backups-restore, joy, wishlist, chatty), xong thì ghi `last-sync.json` (`at`, `startedAt`, `source` timer|manual|catch-up, `ok`, `exitCode`, `apps`, `log`), thả lock, thông báo desktop `notify-send` ("apps_doc đã đồng bộ" / "apps_doc đồng bộ lỗi").
4. **Thay thế từng app không gián đoạn** (`extract` trong `fetch-app-sources.mjs`): giải nén vào `apps_doc/.<slug>.extracting`, đổi tên bản cũ sang `apps_doc/.<slug>.old`, đổi tên bản mới vào `apps_doc/<slug>`, rồi mới xóa `.old`. Một lượt check đang đọc `apps_doc/<slug>` không gặp thư mục trống hay file nửa chừng; `manifest.json` + `README.md` ghi lại commit, ngày tải.
5. **Mốc khởi tạo**: ngày 09/10/2026 `last-sync.json` được ghi từ `apps_doc/manifest.json.updatedAt` (source `manifest`) để phiên mở kế tiếp không tải lại ~900 MB ngay; lần sync đầu theo lịch là Chủ nhật 11/10/2026.

## File và hàm
- `scripts/apps-doc-sync-if-due.mjs` — `SCHEDULE`, `APPS`, `zonedTimeToUtc`, `lastDueAt`, `isDue`, `readLastSync`/`writeLastSync`, `acquireLock`/`releaseLock`, `runSync`, `startIfDue`; CLI `--check`, `--run [--force] [--source …]`, mặc định = kiểm tra và khởi động bù.
- `scripts/install-apps-doc-sync.mjs` — ghi `~/.config/systemd/user/andrew-apps-doc-sync.{service,timer}` (`ExecStart … --run --force --source timer`, `Persistent=true`), `--enable`, `--uninstall`.
- `scripts/fetch-app-sources.mjs` — tải + giải nén + đổi tên nguyên tử, ghi manifest.
- `.claude/settings.local.json` → `hooks.SessionStart`; `skills/check-ticket/scripts/service.mjs` → `start()`.
- Test: `npm run appsdoc:sync:test` (`scripts/apps-doc-sync.test.mjs`: đổi múi giờ, mốc Chủ nhật, đến hạn, lock).

## Dữ liệu lưu
- `runtime/apps-doc-sync/last-sync.json`, `sync.lock` (pid + thời điểm, tự xóa khi xong), `sync-*.log` (output của fetch, không có token); `runtime/apps-doc-sync.log` (stdout của service systemd).
- `apps_doc/` (không commit), `apps_doc/manifest.json`, `apps_doc/README.md`.

## Cài đặt và quyền
- `.env_my` có `BEARER_Auth` (scope `code:archive`); `notify-send` để thông báo desktop (không có thì bỏ qua); Node của máy (`process.execPath` ghi vào unit).
- Không có quyền nào ngoài tải mã nguồn và ghi dưới `apps_doc/`, `runtime/apps-doc-sync/`; không đăng, không gửi tin.

## Giới hạn
- Sync tải ~900 MB; chạy ở nền nhưng tốn mạng vài phút. Lock chỉ chặn trùng trên cùng máy.
- Hook `SessionStart` chỉ chạy khi mở phiên Claude Code; timer `Persistent` chỉ chạy khi phiên user systemd lên. Máy tắt cả tuần và không mở agent thì bản sao vẫn cũ, nhưng Source API vẫn là nguồn chính.
- Sync lỗi (mạng, key) vẫn ghi mốc `ok: false` kèm `at`, nên không tự thử lại trong tuần; chạy tay `npm run appsdoc:sync` khi cần.

## Cách test
1. `npm run appsdoc:sync:test` → 4 test.
2. `npm run appsdoc:sync:check` → `{"due":…, "lastSyncAt":…, "lastDueAt":…}`.
3. Giả lập đến hạn: đổi `at` trong `runtime/apps-doc-sync/last-sync.json` về trước Chủ nhật gần nhất rồi chạy `node scripts/apps-doc-sync-if-due.mjs` → in dòng "đang đồng bộ ở nền", `sync.lock` xuất hiện, log mới trong `runtime/apps-doc-sync/`, xong có thông báo desktop và `last-sync.json` mới.
4. `systemctl --user list-timers andrew-apps-doc-sync.timer` → lần chạy kế tiếp Chủ nhật 03:30.

## Thay đổi
- 09/10/2026: Tạo tính năng và tài liệu (Hanbui, lệnh Đại tá qua Hanlead: "lần khởi động Agent đầu tiên vào chủ nhật thì sync"); đổi tên nguyên tử trong `fetch-app-sources.mjs`; timer đổi sang gọi `apps-doc-sync-if-due.mjs --run`.
