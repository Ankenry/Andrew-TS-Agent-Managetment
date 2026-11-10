# NAVIGATION — thanh điều hướng giữa các trang của web TS Management

## Mục đích
Cho người dùng chuyển giữa các trang của TS Management web: **Tickets**, **Chat bot**, **Checking**, **Analytics**, **DFY Accessibility**, **Notifications** và **Settings**. Trên màn hình rộng (≥ 1024px) thanh này là sidebar bên trái; trên màn hình hẹp (điện thoại) là thanh ngang dưới đáy. Mục **Settings** chỉ hiện icon bánh răng 40px ở góc trái: đáy sidebar (góc dưới-trái) trên desktop, đầu bên trái thanh đáy trên mobile.

## Cách kích hoạt
- Bấm một mục trên thanh → mở trang tương ứng. Mục đang mở được tô sáng (`aria-current="page"`).
- Mục Notifications có badge đỏ số thông báo chưa đọc (`99+` khi quá 99).
- Mục Settings không có chữ; đưa chuột vào hiện tooltip "Settings" (`title`), trình đọc màn hình đọc `aria-label="Settings"`.
- Trang NEWS và Ticket Management không có mục riêng: khi mở chúng, mục Tickets vẫn sáng.
- Trang Tickets có 5 section: Pending, Doing, Wait customer, Dev fix (flow doc `tickets-dev-fix (…).md`) và Feature (từ 12/10/2026, flow doc `tickets-feature (…).md`); desktop hiện 5 cột.

## Luồng từng bước
1. `index.html` có sẵn `<nav id="nav" class="nav">` rỗng dưới `<main id="screen">`.
2. Lần đầu `renderNavigation()` (app.js) chạy: tạo `.nav-brand` (logo + tên, chỉ hiện trên desktop) rồi tạo 7 nút `.nav-button` theo danh sách `[["home","Tickets"],["chat","Chat bot"],["checking","Checking"],["analytics","Analytics"],["dfu","DFY Accessibility"],["notifications","Notifications"],["settings","Settings"]]`, mỗi nút có `data-screen` và icon SVG từ `chatIcon(name)`.
   - Nút Settings được thêm class `nav-settings`, `aria-label`/`title` = "Settings" và chỉ chứa icon, không có span chữ.
3. Bấm nút: nếu là Chat bot thì đóng lịch sử chat (`state.chatHistoryOpen = false`), các nút khác lưu hội thoại đang mở (`saveActiveConversation()`), rồi gọi `showScreen(name)`.
4. `showScreen` đặt `state.screen`, vẽ lại header và navigation, rồi gọi hàm render của trang (`renderHome`, `renderChat`, `renderChecking`, `renderAnalytics`, `renderDfu`, `renderNotifications`, `renderSettings`).
5. Mỗi lần `renderNavigation()` chạy lại (đổi trang, có thông báo mới, đọc thông báo): cập nhật class `active`/`aria-current` cho nút đúng trang và vẽ lại badge Notifications từ `unreadCount()`.
6. Bố cục do CSS quyết định:
   - Mặc định (mobile): `.nav` là hàng ngang dưới đáy, các nút `flex: 1` chia đều; `.nav-settings` có `order: -1; margin-right: auto` nên nằm đầu bên trái, chỉ icon 40px (`.nav-settings .nav-icon/.chat-icon` 40px).
   - `@media (min-width: 1024px)`: `.app` thành lưới 2 cột, `.nav` là cột sidebar dọc; `.nav-settings` có `margin: auto 0 0; justify-content: flex-start` nên bị đẩy xuống góc dưới-trái sidebar, icon 40px.

## File và hàm
- `web/app/app.js` — `renderNavigation()` (tạo nút, class `nav-settings`, badge, trạng thái active), `showScreen()`, `chatIcon()` (SVG các icon, gồm `settings`).
- `web/app/style.css` — `.nav`, `.nav-button`, `.nav-icon`, `.nav-badge`, `.nav-settings`, `.nav-brand`; khối `@media (min-width: 1024px)` cho sidebar desktop.
- `web/app/index.html` — thẻ `<nav id="nav">`.
- `scripts/ts-management-web.mjs` — phục vụ file tĩnh `web/app/` với `Cache-Control: no-cache` (sửa CSS/JS chỉ cần tải lại trang, không cần khởi động lại service).

## Dữ liệu lưu
Không lưu gì. Trang đang mở nằm trong `state.screen` (bộ nhớ trang), mất khi tải lại.

## Cài đặt và quyền
Không cần cài đặt hay quyền riêng. Badge Notifications đọc từ danh sách thông báo đã tải trong `state.notifications`.

## Giới hạn
- Thứ tự và danh sách mục cố định trong code, không cấu hình được.
- Chỉ áp dụng cho web TS Management; thanh điều hướng của Chrome extension (`chrome-extension/widget.js`) là code riêng và chưa đổi theo.

## Cách test
1. Mở `http://andrewtsmanagement.com:5088` ở cửa sổ rộng ≥ 1024px: sidebar trái có 6 mục có chữ, bánh răng 40px nằm riêng ở góc dưới-trái, đưa chuột vào hiện "Settings", bấm mở trang Settings và icon sáng.
2. Thu cửa sổ < 1024px (hoặc mở trên điện thoại): thanh đáy có bánh răng 40px chỉ icon ở đầu bên trái rồi 6 mục có chữ.
3. Headless: chạy Playwright chụp `http://127.0.0.1:5088/` ở viewport 1280×800 và 390×780, kiểm tra `.nav-settings` không có text và có `aria-label="Settings"`.

## Thay đổi
- 08/10/2026: Mục Settings đổi thành chỉ icon và đưa xuống cuối thanh. Tạo flow document này.
- 08/10/2026: Icon Settings tăng lên 40px và chuyển sang góc trái (góc dưới-trái sidebar desktop, đầu trái thanh đáy mobile).
- 10/10/2026: Thêm mục **DFY Accessibility** (icon `dfu`) ngay trước Notifications; trang `renderDfu()` (luồng riêng: `docs/flows/dfu-accessibility (…)`). Trên thanh đáy mobile mục này hiện chữ ngắn **DFU** (`.nav-short`), sidebar desktop hiện đủ (`.nav-long`); chữ các nút thanh đáy giảm còn 9,5px, không xuống dòng, để 7 mục vừa màn hình 390px.
- 11/10/2026: Đổi tên hiển thị mục **DFU Accessibility** thành **DFY Accessibility** (nhãn ngắn trên phone **DFY**) theo lệnh Đại tá; key màn hình `dfu` giữ nguyên.
