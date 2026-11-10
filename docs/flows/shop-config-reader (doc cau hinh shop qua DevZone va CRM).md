# Đọc cấu hình shop qua DevZone và CRM

## Mục đích và cách gọi

Một reader dùng chung cho check tự động, tool check thủ công, CLI và gateway MCP V2, trả cấu hình thực tế có key, giá trị, nguồn và giờ đọc. Reader chỉ đọc cấu hình; không tự gửi email, sửa shop, đăng comment hoặc đổi trạng thái ticket.

CLI từ root workspace:

```bash
node scripts/shop-settings.mjs WISH-261029-hTGHQj --path notifications --json
runtime/mcp-v2/toolchain/node-v22.23.4-linux-x64/bin/node scripts/shop-settings.mjs WISH-261029-hTGHQj --path notifications --engine mcp-v2 --json
```

CLI đọc lại Helpdesk, lấy app và domain canonical của ticket. Không nhận domain, token hay URL API tùy ý. `--engine` chỉ chọn đường preview của lệnh này, không ghi công tắc dùng chung. CLI cần mã ticket, không nhận URL ticket. Không gọi pipeline điều tra/model và không đăng report.

Engine hiện tại gọi `shop_settings {path, source:"auto"}` trong tools-server. Với MCP ON, model chỉ gọi `mcp_v2_read {tool:"ts_shop_settings",arguments:{path}}`; các tool trực tiếp vẫn bị chặn. Gateway đọc `ts_get_ticket`, kiểm mã ticket/app và yêu cầu đúng một domain myshopify trước khi đọc. Không đổi remote `connection.json`, không thêm quyền API ghi hay CRM path tự do.

## Luồng và adapter đã duyệt

1. Khóa app/domain theo ticket; kiểm path và ngân sách. Chặn secret path, prototype path, URL hoặc tham số lạ. Cache riêng một reader/job/client, chứa dữ liệu đã che bí mật, khóa theo ticket/app/shop/path/source. Tối đa 3 lần đọc không nằm trong cache mỗi instance; tool còn chịu ngân sách lượt/deadline điều tra.
2. Đọc key tại backend từ `.env_my`. Machine API ưu tiên `DEVZONE_API_KEY_<APP>` rồi các tên key chung hiện có. Không suy loại credential từ lỗi HTTP.
3. Các machine adapter giữ nguyên: Order Tracking GET `/api/v1/settings`; Air Reviews GET `/api/v1/settings/all` và supplemental `/api/v1/custom-css`; Air EDD GET `/api/v1/settings`. Headers `X-DevZone-Key`, `X-Shop-Domain`. Không theo redirect. Không gọi endpoint tạo mặc định `/email-notifications` của Order Tracking.
4. Wishlist chưa có machine adapter được duyệt ở đây. Reader dùng CRM Public Admin `https://us-central1-avada-crm.cloudfunctions.net/publicAdminApi/api`, Authorization Bearer với `CRM_TOKEN`. Đây là contract riêng với CRM UI `/api` dùng Firebase `x-auth-token`.
5. GET `/shops/search?searchString=<canonical-domain>`; chọn duy nhất record khớp cả `appName=wishlist` và `shopifyDomain`. Ngay tại ranh giới này chỉ giữ id/appName/domain, bỏ toàn bộ token/PII của record. GET `/login/<id>?appType=wishlist` với redirect manual; chỉ chấp nhận Location cùng origin `https://wishlist.joy.so`, path `/authSa/a/login`, đúng hai tham số `apiKey`, `token`, không trùng key. Không chuyển CRM Bearer sang app.
6. Chromium headless trong context mới, service workers bị chặn, không dùng profile cá nhân và không ghi storageState. Chỉ mở URL login đã kiểm, trang root/static assets cần thiết, Firebase JS và đúng endpoint xác thực custom-token/account-info của Firebase hiện đại hoặc bản 7.2.0. Chặn tất cả `/apiSa/*` do UI tự phát sinh; chỉ đọc header token từ request bị chặn, kiểm expiry và tenant `shopID` (CRM support `sub` là UID người hỗ trợ). GET `/apiSa/shops` có thao tác cập nhật quickstart/Crisp/wishlist URL; GET `/design` có thể backfill translation nên cả hai không được truyền đi.
7. Dùng token app trong bộ nhớ để GET đúng allowlist Wishlist: `/apiSa/settings`, `/apiSa/notifications/email-header`, `/apiSa/notifications/sender`. Browser không nhận script/click/fill từ model; đóng browser/context sau xác thực, cả khi timeout/sai tenant. `authentication.blockedAppPaths` ghi path đã chặn, không có token/query.
8. Che secret/PII/URL query có token trước khi chọn field, cache, trả JSON hay ghi tool-log. Field `false` được giữ; missing/null response khác `false`; source chưa thử khác auth rejection. Timeout tổng mặc định 60 giây, HTTP mỗi lần 10 giây, login sau khi launch tối đa 30 giây, response tối đa 2 MB. Browser launch có timeout 20 giây riêng. Transport không log raw body/error.
9. Với engine hiện tại, khi API/admin không đọc được, `shop_settings` có thể đọc storefront đã khóa host theo ticket như trước. CLI và MCP config operation không có generic storefront fallback. Các app chỉ có storefront vẫn dùng helper hiện có; không mở thêm admin adapter cho chúng.

## Giá trị, bằng chứng và lỗi

Reader trả `ok`, `state`, `observations`, `attempts`; observation có `path`, `value`, `source`, `endpoint`, `at`, và semantics cho admin. Các state: `read`, `partial`, `missing`, `auth_failed`, `unavailable`. Mỗi attempt ghi `read`, `missing`, `failed` hoặc `untried`, mã lỗi và HTTP status/endpoint khi có. Missing credential là chưa thử; 401/403 là `AUTH_REJECTED`, không chứng minh key UI hay machine. Lỗi thường gặp: `CRM_TOKEN_MISSING`, `CRM_SHOP_NOT_FOUND`, `CRM_SHOP_AMBIGUOUS`, `CRM_LOGIN_DESTINATION_REJECTED`, `QUICK_LOGIN_TIMEOUT`, `LOGIN_SHOP_ID_MISMATCH`, `FIELD_NOT_IN_REVIEWED_ADAPTER`, `FIELD_MISSING`, `CONFIG_BUDGET_EXHAUSTED`.

Wishlist getters trả cấu hình hiệu lực, có merge defaults; không coi đó là bản chụp DB thô. Riêng `/settings` có thể trả notification legacy/default khác endpoint chuyên biệt. Với logo/sender luôn dùng `notifications.emailHeader` / `notifications.sender`; không kết luận `settings.notifications.sender.mode=default` là trạng thái sender thật khi chưa đọc endpoint sender. Không suy các notification khác đã được kiểm từ ba endpoint này.

Tool hiện tại có ref `settings:<app>/api` hoặc `/admin`; gateway có ref `mcp-v2:<app>/<id>` riêng cho mỗi call, kind observation. Verifier đối chiếu đúng ref/quote; một call thất bại chỉ hỗ trợ gap truy cập, không chứng minh setting đã đọc. Marker cấu hình cho hậu kiểm do verifier sinh từ call `ts_shop_settings` đã khớp, không tin marker model tự nộp. Nhãn UI chỉ lấy sau khi đối chiếu Source API, không tự biến tên key thành label.

## File và dữ liệu

- `skills/check-ticket-v2/scripts/config-reader-http.mjs`: GET có timeout/size cap, redirect manual, safe errors.
- `config-reader-crm.mjs`: allowlist app/route, selection CRM, validation Location.
- `config-reader-login.mjs`: browser xác thực cô lập, request allowlist, tenant check và cleanup.
- `config-reader.mjs`: điều phối, che dữ liệu, cache/budget, evidence/formatter.
- `scripts/shop-settings.mjs`: CLI đọc lại ticket; không ghi queue/ACK/dedup/settings.
- `skills/check-ticket-v2/scripts/tools-server.mjs`, `prompts.mjs`, `verify.mjs`, `shop-settings.mjs`: tích hợp current/MCP, ngân sách và bằng chứng cấu hình.
- `prepare.mjs` và cache storefront trong tools-server che cấu hình trước khi lưu/thu hẹp path; không để việc chọn một field email/token làm mất lớp che dữ liệu.
- `skills/mcp-v2/scripts/client.mjs`: operation local đã duyệt `ts_shop_settings`, schema path/source và khóa ticket. Không đụng generic browser readiness.
- `.agents/skills/read-shop-config/SKILL.md`: hướng dẫn thực hiện và diễn giải cho agent.

Không lưu credential, raw CRM record, tokenized login URL, cookie hoặc Firebase session. Tool output đã che đi vào tool-log theo cơ chế cũ. `token=hidden` trong URL logo không phải link tải được. Artifact nghiệm thu ở `runtime/agent-artifacts/hanski-devzone-20261029/`, mode 0600, thư mục 0700.

## Nguồn audit 29/10/2026

Source API Wishlist commit `1927b195`, các file được read mới nhất trước khi kết luận:

- `packages/functions/src/handlers/authSa.js:33` đăng ký standalone `/authSa`, không có hook merchant `afterLogin`; `handlers/apiSa.js:20` dùng verifyRequest. Chỉ login được cho qua, không installation/callback/auth merchant.
- `firebase.json:45-98`: hosting static, root fallback `/standalone.html`; root/static được phép không đi qua merchant app handler.
- `controllers/shopController.js:45` refresh wishlist URL, cùng cập nhật quickstart/Crisp trong getUserShops; `controllers/designController.js` có backfill: không gọi.
- `repositories/settingRepository.js:58` và `:80`, `repositories/notificationSettingsRepository.js:28`: getter; `services/notificationSettingsService.js:419` sender chỉ đọc, `:496` email header merge defaults.
- `packages/assets/src/helpers.js:93` app admin dùng `x-auth-token`; `pages/Notifications/SenderDetails/SenderDetailsContent.js:482` ánh xạ `emailHeader.logoUrl` đến label translation; `locale/translations/en.json:1284` “Sender email logo”, `:1285` “Upload email logo”, `:1296` “Custom”. Logo này nằm trong email, không chứng minh thay avatar inbox.
- CRM Public Admin base/Bearer được xác minh qua Source API Chatty `config/avadaCrm.js`, `services/avadaAppsService.js`, đối chiếu live search/login và UI auth contract. Không thử token UI trên API công khai hoặc ngược lại.

## Kiểm thử và triển khai

Focused tests: `node --test skills/check-ticket-v2/scripts/config-reader.test.mjs` và Node 22 chạy `scripts/mcp-v2-config-reader.test.mjs`. Regression dùng Node 22 cho `skills/check-ticket-v2/scripts/*.test.mjs scripts/mcp-v2*.test.mjs`. Tests chỉ dùng fixture, browser test chặn mạng; không đổi persisted MCP toggle. Hai fixture cũ được sửa để scope nút refresh vào card MCP khi UI có card khác cùng label, và hỗ trợ shebang của Node private có dấu cách.

Live acceptance chỉ là config preview WISH-261029-hTGHQj bằng current CLI và MCP operation, không chạy điều tra lại hoặc post ticket. Bằng chứng hiện có: hai nguồn chuyên biệt trả logo đã lưu, sender custom đã verified/activated; GET shops bị chặn. Không phải nghiệm thu gửi email/avatar hay toàn bộ ticket.

Mã là candidate; chưa restart dịch vụ hoặc đổi toggle trong nhiệm vụ này. Process mới có thể nạp file mới ngay; module đã import trong process lâu sống chưa được coi là nạp lại. Trước activation cần phê duyệt riêng cho restart tối thiểu, kiểm job đang chạy/queue, chụp read-only queue/cursor/ACK/dedup và settings revision, tránh replay. Sau phê duyệt mới reload web/notifier/bridge thực sự giữ module liên quan, kiểm PID/start-time/health, readback toggle/revision không đổi và receipts không mất. Không restart BSK/browser service vì reader dùng browser cô lập tạm thời. Sau đó thử một preview được chọn rõ ràng; controller posting vẫn theo quyền hiện có, không hồi phục job cũ.

## Thay đổi

- 29/10/2026 — Hanski: thêm reader chung, Wishlist CRM auth-only fallback, CLI, operation MCP, bằng chứng và skill; candidate kèm kiểm thử/live preview, chưa activation dịch vụ.
- Nghiệm thu cuối 29/10: 203/203 tests pass, current CLI + gateway MCP + pipeline tool đọc được cùng logo/sender của ticket WISH; readback default OFF revision 0, settings file chưa tồn tại. Báo cáo và manifest: `runtime/agent-artifacts/hanski-devzone-20261029/FINAL.md`.
