# Kiểm tra lưu lượng Helpdesk External API — 28/10/2026

## Số liệu được cung cấp

Ảnh: https://capture.avada.io/i/U7IFF1pOMaxV (bảng tổng hợp Cloud Run do Đại tá gửi; ảnh chỉ chụp phần đầu bảng).

| Chỉ số của team Andrew/TS2 | Giá trị trên ảnh |
| --- | ---: |
| Tổng lượt External API trong khoảng gần 24 giờ, 27–28/10 | 17.380 |
| Giờ cao nhất | 2.186 lượt |
| `GET /tickets/:id/actions` (nhóm route hiển thị trên ảnh) | 15.915 lượt, khoảng 91,6% tổng |

Ảnh là số tổng theo route, không chứa caller, ticket ID hay từng giờ. Vì vậy không thể quy chính xác 15.915 lượt cho một tiến trình chỉ từ ảnh. Kiểm tra dưới đây dựa trên mã đang có và tiến trình chạy trên máy lúc 14:32 ICT, 28/10.

## Các luồng có thể gọi `/tickets/:id/actions`

| Luồng | Điều kiện và nhịp | Cách tạo lượt `/actions` | Mức liên quan |
| --- | --- | --- | --- |
| Đồng bộ reaction Analytics, `scripts/hachimi-trace-web.mjs` → `scripts/hachimi-analytics-store.mjs` | Chạy lúc tracing web khởi động và mỗi 10 phút. Gom comment AI trong 90 ngày cùng ticket mới phát hiện. | `syncTicket()` gọi một `GET /tickets/:id/actions?type=commentTicket&limit=100` cho **mỗi ticket**, kể cả ticket không có reaction mới. HTTP 429 có thể gây thêm lượt retry. | **Nguồn lớn nhất có khả năng cao.** CSDL hiện có 307 ticket khác nhau trong cửa sổ 90 ngày. Một lượt đầy đủ có thể xấp xỉ 307 request; 6 lượt/giờ là xấp xỉ 1.842 request/giờ khi máy chạy liên tục. |
| Trang Analytics trên extension hoặc TS Management web, dùng chung `chrome-extension/analytics-view.js` | Khi trang đang hiện, gọi `POST /sync {recentDays:3}` lúc mở và mỗi 60 giây; server chặn lặp trong 45 giây và bỏ lượt nếu sync khác đang chạy. | Cũng đi qua `syncReactions()` và `syncTicket()`. CSDL hiện có 32 ticket có comment AI trong 3 ngày gần đây; một lượt gần đây có thể xấp xỉ 32 request, tối đa xấp xỉ 1.920/giờ nếu một trang hiện liên tục và không bị bỏ lượt. Nhiều trang cùng mở không cộng tuyến tính vì dùng chung khóa `syncState.running`. | Có thể là nguồn lớn thứ hai hoặc nguồn chính trong các giờ mở Analytics. Việc refresh biểu đồ mỗi 15 giây chỉ đọc CSDL địa phương, không tự gọi Helpdesk. |
| Check ticket tự động và lệnh `@han`, `skills/check-ticket/scripts/service.mjs` chạy trong `ticket-notification-to-telegram.mjs` | Quét mỗi 5 phút. | Đọc `/actions` cho ticket được gán **có `updatedAt` mới hơn cursor** để tìm comment lệnh; các job review, ACK và đối chiếu comment cũng có thể đọc action. Không đọc action của mọi ticket trong mỗi vòng quét. | Có phát sinh, nhưng mã không cho thấy vòng quét hàng trăm ticket `/actions` mỗi 5 phút khi không có cập nhật. |
| Theo dõi `waiting_customer` của TS Management web và extension | Mỗi 5 phút khi `autoScans` bật ở web; extension có alarm 5 phút. | Với mỗi ticket đang ở `waiting_customer`, đọc ticket đầy đủ và `/actions?limit=100` để tìm lần đổi trạng thái và comment mới. Web hiện có `autoScans: true`; chưa đo số ticket ứng viên và chưa xác nhận extension có chạy cùng lúc. | Có thể đáng kể nếu hàng chờ lớn hoặc hai client cùng quét; cần log theo caller để định lượng. |
| Dev Fix, kiểm tra thủ công, soạn mail/draft và AI context | Theo lịch hoặc khi người dùng thao tác. | Đọc action của ticket đang xử lý; một số luồng phân trang comment. | Có phát sinh, khó giải thích khối lượng 15.915 nếu không có nhiều job liên tục. |

## Đối chiếu nhanh

- Tracing web đang chạy (`scripts/hachimi-trace-web.mjs`, PID 3246). `GET http://127.0.0.1:5077/api/analytics/sync` lúc kiểm tra trả `lastRun=2026-10-28T07:30:37.473Z`, `tickets=33`, `comments=36`, `lastError=""`. Đây là **lượt gần nhất**, có thể là lượt 3 ngày; không đại diện cho lượt đầy đủ 90 ngày.
- Kiểm tra lại lúc **14:39 ICT, 28/10**: trạng thái lượt Analytics gần nhất là `lastRun=2026-10-28T07:38:39.684Z`, `tickets=323`, `comments=323`, `lastError=""`. Đây là **323 ticket được xử lý trong một lượt đồng bộ**, tức tối thiểu một lần đọc `/actions` thành công cho mỗi ticket trong lượt đó; không phải tổng request của cả ngày và có thể còn request retry.
- CSDL `ai_check_reviews` lúc kiểm tra có **307 ticket** trong 90 ngày và **32 ticket** có comment trong 3 ngày. Các con số này thay đổi theo thời gian và lượt phát hiện ticket mới.
- 15.915 lượt `/actions` tương đương khoảng **52 lượt đồng bộ đầy đủ × 307 ticket**; nếu các lượt đó cách nhau 10 phút thì khoảng 8 giờ 40 phút máy chạy. Đây chỉ là phép đối chiếu quy mô, **không phải bằng chứng 52 lượt đã xảy ra**. Trang Analytics, các luồng khác, retry 429 và lượt sync bị bỏ đều có thể làm tỷ lệ thực tế khác đi.
- Mức đỉnh 2.186 lượt/giờ cùng bậc với 1.842 lượt/giờ ước tính từ Analytics đầy đủ. Do thiếu breakdown theo caller và theo phút, chưa thể xác nhận riêng giờ đỉnh do luồng nào gây ra.

## Kết luận và bước xác minh tiếp theo

Đường gây tải có khả năng cao nhất là **Analytics đọc lại toàn bộ action log của từng ticket cũ mỗi 10 phút**; trang Analytics đang mở cũng tạo sync 3 ngày mỗi phút. Luồng `waiting_customer` là nguồn phụ cần định lượng. Chưa thay đổi cấu hình, code hay dịch vụ trong lần điều tra này.

**Chưa có thống kê số lượt thực tế theo từng luồng/tiến trình trong khoảng 24 giờ trên ảnh.** Log địa phương hiện không ghi caller cho từng Helpdesk request; ảnh Cloud Run chỉ tổng hợp theo team và route. Vì vậy các phép nhân chu kỳ ở trên là ước tính năng lực tạo tải, không phải breakdown đo được. Không thể khôi phục chính xác phần lịch sử này từ các dữ liệu hiện có.

Để có số thật từ thời điểm triển khai trở đi, thêm bộ đếm theo `process/flow + method + route + thời điểm` ở các Helpdesk client (Analytics, notifier/controller, TS Management web, extension, Dev Fix), bao gồm cả retry và mã HTTP; ghi số tổng theo giờ, không ghi token, URL ticket hay nội dung. Kiểm tra một ngày số đo này với Cloud Run rồi mới chọn cách giảm tải: chỉ sync ticket có thay đổi/reaction mới, kéo dài chu kỳ full scan, hoặc dùng webhook reaction nếu Helpdesk hỗ trợ. Việc sửa client và kích hoạt dịch vụ chưa nằm trong lần điều tra này.
