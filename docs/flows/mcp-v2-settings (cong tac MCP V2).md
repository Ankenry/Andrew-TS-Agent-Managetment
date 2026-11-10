# MCP V2 Settings — công tắc chiến dịch MCP V2

## Mục đích và cách dùng

Trong **Settings** của TS Management web và widget Chrome, khối **chiến dịch MCP V2** điều khiển cùng một cấu hình trên máy chủ. OFF giữ luồng check ticket hiện tại; ON chọn luồng điều tra MCP V2 theo các capability đã xác minh. Trạng thái MCP đọc dữ liệu được tách khỏi trình duyệt/CSS; chọn ON không chứng minh BrowserSkill đã sẵn sàng. Đây là lựa chọn cho lượt check mới, không phải thông báo một job đang chạy. Cấu hình mặc định do backend trả về là OFF khi chưa có file lưu.

Người dùng bấm công tắc hoặc dùng Tab và Space. Khối hiển thị lựa chọn đã đọc, luồng có hiệu lực, trạng thái chưa sẵn sàng và nút **Đọc lại cấu hình**. Nếu backend chưa đọc được, công tắc bị khóa và ghi rõ chưa xác minh; trạng thái chưa biết không được coi là OFF. Nếu ON nhưng V2 không sẵn sàng, giao diện báo bị chặn, không tuyên bố đang chạy hoặc tự chuyển sang luồng cũ. OFF vẫn cho thấy lý do V2 chưa sẵn sàng.

## Luồng đọc và lưu

1. Mở Settings, tải lại trang hoặc quay lại cửa sổ/tab → GET `/api/mcp-v2/settings`. Nút Đọc lại cũng gọi GET. Web gọi cùng origin bằng header mã truy cập hiện có; widget gửi message `mcp-v2-settings` tới background rồi background gọi máy chủ loopback 5088.
2. Response giữ `enabled:boolean`, `effectiveEngine:'current'|'mcp-v2'`, `available:boolean`, `reason:null|string`, `revision:integer`, thêm `capabilities.remoteMcp`, `capabilities.browser`, `capabilities.cssPreview` với `available:boolean` cho từng khả năng. Hợp đồng bổ sung: `runtime/mcp-v2/activation/capability-response.proposed.json`. UI kiểm tra kiểu dữ liệu, không lấy flag từ `chrome.storage.local`, `localStorage` hoặc bản bootstrap cũ.
3. Người dùng bật/tắt → đúng một PUT `/api/mcp-v2/settings` với `{enabled, expectedRevision}` lấy từ lần đọc gần nhất. Trong lúc lưu, khóa công tắc và nút đọc lại; sự kiện focus không chen GET vào thao tác lưu.
4. Sau PUT, luôn GET đối chiếu. Mất phản hồi PUT cũng chỉ GET, không tự PUT lại. Lỗi 409 do revision cũ, 503 khi bật nhưng V2 chưa sẵn sàng, 500 do lưu thất bại đều hiển thị lỗi và đọc lại giá trị hiện tại. Nếu đối chiếu thất bại, giá trị cũ chỉ được ghi là lần đọc gần nhất; khóa công tắc tới khi đọc lại thành công.
5. Mỗi lần đọc có số thứ tự trong bộ nhớ. Phản hồi cũ không ghi đè phản hồi mới. Rời Settings hoặc render lại sẽ tháo listener của khối cũ và vô hiệu hóa phản hồi đang chờ. Không có vòng polling nền; đồng bộ giữa hai giao diện được bảo đảm khi mở/focus/reload/đọc lại, không tuyên bố cập nhật tức thì trên hai màn hình đang mở yên.

### Hiển thị capability riêng

- **MCP đọc dữ liệu: sẵn sàng** chỉ khi `capabilities.remoteMcp.available === true`. Giá trị `false` hiện **chưa sẵn sàng**; thiếu hoặc sai kiểu hiện **chưa xác minh**.
- **Trình duyệt/CSS: sẵn sàng** chỉ khi cả `capabilities.browser.available` và `capabilities.cssPreview.available` đều là boolean `true`. Khi cả hai field là boolean và ít nhất một field `false`, hiện **Trình duyệt/CSS: chưa sẵn sàng**. Thiếu hoặc sai kiểu một trong hai field hiện **chưa xác minh**.
- Không suy diễn capability từ `available:true` ở cấp ngoài, engine ON, việc có binary `bsk`, hay cờ cài đặt khác. Response cũ thiếu capabilities vẫn đọc được toggle/revision, nhưng không tuyên bố trình duyệt/CSS đã được xác minh. Khi đọc lỗi/offline hoặc đang xác minh lại, cả hai dòng capability hiện **chưa xác minh**, không dùng nhãn sẵn sàng của snapshot cũ.
- Backend sở hữu readiness và bằng chứng browser profile; UI chỉ hiển thị các cờ đã trả về, không chạy browser/MCP probe để kiểm tra capability. Capability không ghi thêm flag cục bộ và không đổi quy tắc PUT/revision/engine-race hiện có.

## Chọn luồng điều tra từ chat

- Nút **Check** của ticket Doing tạo câu `Check ticket <mã ticket>` và payload `{message, chatId, ticket:{ticketId}, intent:'ticket-review', reviewFollowUp:false}`.
- Các lệnh hoàn chỉnh `check tiếp`, `check tiep`, `check lại`, `check lai`, `recheck` dùng ticket đang được chọn hoặc mã/link Helpdesk ghi rõ sau lệnh; gửi `reviewFollowUp:true`. Với check tiếp không có mã trong câu, chỉ dùng trường `selectedTicket.ticketId` hiện tại; không tìm ticket từ lịch sử tin nhắn. Mã phải khớp hợp đồng backend; thiếu hoặc sai thì hiện lỗi.
- Parser cố ý nhận các dạng lệnh hoàn chỉnh ở trên. Không suy diễn intent từ câu tự do, việc có selectedTicket, kết quả review trước đó hoặc câu hỏi kết thúc bằng `?`. Câu hỏi thường, chat và yêu cầu viết mail giữ luồng aiProvider hiện có.
- Web gửi POST `/api/ai/chat`; backend Hanski sở hữu quyết định engine. Extension kiểm tra cấu hình chung chỉ với intent điều tra: OFF tiếp tục đúng dispatch provider trước đây; ON và available gửi POST `/chat` tới Codex bridge, bỏ qua aiProvider của chat. Backend đọc lại ticket thật từ `ticket.ticketId`; widget không gửi description/comment cũ vào request MCP.
- Request bridge giữ `message`, `chatId`, thêm `intent`, `ticket.ticketId`, `reviewFollowUp` và traceId nếu có. Response giữ `{answer}`, đồng thời bảo toàn `engine`, `revision`, `runId` nếu backend trả. Timeout extension 610 giây, dài hơn giới hạn điều tra 600 giây của backend; mất phản hồi không tự chạy lại hoặc fallback.
- Extension còn gửi `expectedEngineRevision` lấy trực tiếp từ `campaign.revision` vừa đọc; không dùng revision do message đầu vào tự cung cấp. Revision thiếu/sai bị chặn trước POST. Hợp đồng backend yêu cầu snapshot vẫn ON và revision khớp; thay đổi ON → OFF hoặc ON sang revision khác trước khi bridge nhận sẽ trả `409 MCP_ENGINE_CHANGED`, không gọi pipeline hay legacy. Khi nhận đúng lỗi này, extension GET cấu hình một lần và báo lựa chọn hiện tại (hoặc chưa đọc lại được), kết thúc yêu cầu; không tự POST lại hay chuyển provider. Người dùng chủ động xem Settings và gửi lại Check nếu cần. Web trực tiếp `/api/ai/chat` không thêm trường này vì backend chụp snapshot một lần.
- Khi không đọc được cấu hình chung, extension không thể xác minh OFF/ON cho yêu cầu điều tra và báo lỗi. Cần triển khai backend tương ứng trước khi dùng giao diện mới. Generic chat không phụ thuộc endpoint cấu hình này.

## File và dữ liệu

- `web/app/app.js`: `createMcpV2SettingsCard`, `mcpV2SettingsRequest`, `ticketReviewRequest`, nối vào `renderSettings`, `showScreen`, `sendChat`.
- `chrome-extension/widget.js`: khối UI, intent và lifecycle tương ứng; gửi message qua `request`.
- `chrome-extension/background.js`: message `mcp-v2-settings`, transport GET/PUT, nhánh intent trong `requestWidgetAiChat`, `requestMcpV2TicketReview` gọi bridge. Không thêm quyền extension hoặc tự start/restart dịch vụ.
- Backend do Hanski quản lý: `scripts/mcp-v2-settings.mjs`, `scripts/mcp-v2-review.mjs`, `scripts/ts-management-web.mjs`, `scripts/codex-ticket-bridge.mjs`, native actions `mcp-v2-settings-get/set`. Kho chung là `runtime/mcp-v2/settings.json`; UI không ghi file trực tiếp.
- `scripts/mcp-v2-settings.test.mjs`: kiểm thử hợp đồng transport, UI thật trong Chromium headless cô lập, routing và backend settings trên thư mục tạm. Hai bản hàm UI/intent được kiểm tra bằng nhau để tránh lệch hành vi; không thêm loader/script hay thay manifest.

## Quyền, giới hạn và kiểm thử

Chỉ thao tác công tắc của người dùng mới gửi PUT cấu hình. GET/mở Settings không ghi giá trị mặc định, chạy review, đăng comment hoặc đổi ticket. Browser, engine và quyền posting vẫn theo backend/workflow; công tắc không mở thêm quyền shop. Header truy cập web dùng cơ chế có sẵn, không đưa credential vào nội dung UI hoặc tài liệu.

Chạy `node --test scripts/mcp-v2-settings.test.mjs` và `node --check` cho ba file JS thay đổi. Test dùng Playwright đã có trên máy và `/usr/bin/google-chrome`, chặn toàn bộ mạng bằng fixture. Backend settings thật chạy với `root` là thư mục tạm và readiness mô phỏng; không đụng `runtime/mcp-v2/settings.json` production. Các POST cũ phát sinh khi web khởi tạo (ví dụ dev follow scan) cũng bị fixture chặn, không thực thi dịch vụ.

Các ca kiểm tra: mặc định không tự lưu; bật/tắt và readback; reload đồng bộ web → extension → web; focus; thao tác bàn phím và pointer; desktop 1280×900/mobile 390×844; lưu thất bại; 409; ON unavailable/503; response malformed; offline; mất phản hồi sau khi đã lưu; readback thất bại; GET cũ tới muộn; rời Settings; Check/check tiếp có intent; câu hỏi/mail có selectedTicket vẫn không có intent; OFF giữ provider, ON dùng bridge và không fallback.

Kiểm thử capability trên cả web và extension: remote true/browser false/CSS false; thiếu toàn bộ capabilities; thiếu browser hoặc CSS; giá trị chuỗi `"true"`; có `bskInstalled:true` nhưng chưa có capability; remote false độc lập với `available:true` cấp ngoài; cả ba true rồi offline phải trở lại chưa xác minh. Các ca chỉ GET, toggle giữ OFF và revision giữ nguyên. Ảnh bổ sung `runtime/screenshots/hanbui-mcp-v2-{web,extension}-capabilities-mobile.png` là fixture của remote đã sẵn sàng, browser/CSS chưa sẵn sàng.

Ảnh fixture: `runtime/screenshots/hanbui-mcp-v2-{web,extension}-{desktop,mobile}.png`. Đây là bằng chứng UI mô phỏng, không phải bằng chứng production đã nạp code hoặc MCP đã sẵn sàng. Chưa restart production, reload extension thật, bật chiến dịch trên store thật hay chạy điều tra live trong nhiệm vụ UI này. Readiness TS Elite MCP/BrowserSkill và kiểm thử end-to-end live còn thuộc đợt xác nhận backend/triển khai được duyệt riêng.

## Thay đổi

- 27/10/2026 — Hanbui: thêm Settings và đồng bộ qua hợp đồng backend Hanski; truyền intent điều tra rõ ràng; kiểm thử fixture và backend store tạm. Quyền làm trong session hiện tại dù ORCA handle lệch đã được Đại tá duyệt qua Hanlead; không thay binding.
- 27/10/2026 — Theo duyệt bổ sung Hanlead: thêm expectedEngineRevision cho extension, xử lý 409 bằng GET rồi dừng; test forwarding, ON → OFF, đổi revision khi vẫn ON, readback offline và revision không hợp lệ. Test phía UI mô phỏng phản hồi 409; phần backend thực thi chặn pipeline/legacy do Hanski kiểm chứng riêng.
- 27/10/2026 — Theo duyệt prerequisite activation: tách remote MCP khỏi browser/CSS trong widget/web, giữ ba trạng thái sẵn sàng/chưa sẵn sàng/chưa xác minh. Hanlead thông báo preview remote MCP thật đã xác minh, BrowserSkill vẫn chưa xác minh; nhiệm vụ UI này kiểm chứng hiển thị bằng fixture, không tự bật production, reload UI thật hoặc sửa backend.
