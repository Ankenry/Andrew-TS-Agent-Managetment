# Trace widget / automatic check-ticket vào cuộc trò chuyện Codex

`check-ticket-chat-relay.mjs` theo dõi log widget và state automatic mỗi 2 giây.
Mỗi lượt mới gửi đúng một yêu cầu `codex queue --thread <UUID> --message ...`
vào cuộc trò chuyện đã cấu hình. Không cần một terminal chạy viewer riêng.

Trong lượt tiếp theo, Hachimi đọc các mốc đã ghi và báo trong commentary cho
đến Done/lỗi/ngắt kết nối. `read-check-ticket-trace.mjs` có cursor và mỗi lần
chờ tối đa 30 giây. Không gọi lại AI hay thay đổi Helpdesk. Chỉ chuyển tiến
độ quan sát được và kết quả; không chuyển reasoning/thinking nội bộ.

Nếu Codex đang bận, yêu cầu chờ trong queue; nếu phiên đã đóng, phải mở lại
đúng cuộc trò chuyện để nhận. Receipt `queued` chỉ chứng minh Codex nhận vào
queue, chưa chứng minh nội dung đã hiển thị. Không dùng `exec resume` để tạo
một worker cạnh tranh với phiên đang mở; không chèn giả assistant messages
vào lịch sử, không tự gõ vào TTY.

## Cài và vận hành

```
node scripts/install-check-ticket-chat-relay.mjs --thread <conversation-UUID>
systemctl --user status andrew-check-ticket-chat-trace.service
journalctl --user -u andrew-check-ticket-chat-trace.service -n 30
```

Installer ghi unit user systemd, bật khởi động khi đăng nhập và chạy ngay.
`flock` bảo đảm chỉ một relay chạy. Configuration và receipt ở:

- `runtime/check-ticket/chat-relay-config.json`
- `runtime/check-ticket/chat-relay-state.json`

Lần cài đầu chỉ theo dõi các lượt mới từ `activatedAt`, không phát lại lịch
sử. Restart giữ cursor/receipt. Nếu queue có kết quả chưa rõ, giữ `uncertain`
để kiểm tra thay vì tự gửi trùng. Relay bị tắt không ảnh hưởng việc check.

```
systemctl --user disable --now andrew-check-ticket-chat-trace.service
```

Không tự đổi thread đích. Installer từ chối nếu cấu hình đã thuộc thread
khác. Mỗi trace có một yêu cầu theo dõi, không phải một lượt AI cho mỗi token.
Việc Hachimi đọc và trình bày trace vẫn dùng lượt Codex hiện hành.

Kiểm thử: `node scripts/check-ticket-chat-relay.test.mjs`.
