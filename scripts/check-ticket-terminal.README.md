# Log check-ticket trong terminal

`check-ticket-terminal.mjs` đọc state hiện tại mỗi 2 giây và health local mỗi
15 giây. Mỗi terminal hiển thị lần quét mới, trạng thái xử lý, lỗi, tiến độ
Telegram và toàn bộ comment của job đã được xác nhận `done`. Khi vừa mở,
hiển thị kết quả gần nhất với nhãn trạng thái đã lưu, cùng các job chưa xong.
Viewer không khởi động hay dừng dịch vụ, không gọi AI và không ghi Helpdesk.

Cài hook Bash bằng `node scripts/install-check-ticket-terminal.mjs`.
Installer sao lưu `~/.bashrc` và không thêm hook trùng lặp.
Mỗi Bash tương tác có TTY tự mở viewer. Ctrl+C trở về shell.
Chạy lại bằng `checkticket-log`; xem một lần bằng `checkticket-log --once`.
Tạm bỏ qua tự mở bằng biến `CHECK_TICKET_LOG_AUTOSTART=0` trước khi mở Bash.
Gỡ tự mở bằng cách xóa block `# Andrew check-ticket terminal viewer` trong
`~/.bashrc`. Các shell không tương tác không mở viewer.

Kiểm tra: `node --test scripts/check-ticket-terminal.test.mjs`.

## Chatbot widget

Các lượt chat trực tiếp trong widget (Elite 2, Hachimi, hoặc kết hợp) gửi tiến
độ qua Native Messaging có sẵn vào `runtime/check-ticket/widget-chat.jsonl`
(quyền 0600). Terminal theo dõi các dòng mới: bắt đầu, giai đoạn, chờ phản hồi
mỗi 15 giây, các đoạn câu trả lời khi có stream, Done/lỗi/ngắt kết nối.
Provider trả lời một lần sẽ in toàn bộ kết quả khi trả về. Done ở đây nghĩa là
widget nhận xong câu trả lời, không phải đã đăng comment Helpdesk.

Chỉ log nội dung trả lời và các mốc tiến độ định sẵn, không log reasoning,
token đăng nhập, headers hay toàn bộ dữ liệu request. Lỗi ghi log không làm
hỏng chat. Nếu Native Messaging không ghi được, extension ghi cảnh báo vào
console; không tự gửi lại đoạn log có trạng thái giao nhận chưa rõ.

Sau khi cập nhật, Reload TS Management trong `chrome://extensions`, rồi tải
lại trang Helpdesk. Terminal đã mở viewer cũ cần Ctrl+C rồi `checkticket-log`.
Các terminal mới tự nạp viewer mới. Không cần khởi động lại dịch vụ review.

Kiểm tra thêm: `node scripts/widget-chat-log.test.mjs`.
