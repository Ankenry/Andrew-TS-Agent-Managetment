# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

React + TypeScript + Vite, với Node API riêng. Đây là phương án Hanlead đề xuất và An/Andrew đã chọn bằng câu trả lời “phương án 1 đi”. App có boundary độc lập tại `apps/andrew-brain`; không dùng chung server hoặc sửa giao diện TS Management.

## Users

Người dùng cá nhân: An, tên làm việc Andrew; Technical Support, team Customer Success. Không phải ứng dụng dùng chung cho cả team ở phạm vi hiện tại.

## Product Purpose

Một ứng dụng Second Brain và trợ lý ảo cho Andrew: tập hợp cách truy cập ghi chú hiện có, tìm lại kiến thức, đọc nguồn và trao đổi dựa trên những nguồn được chọn. Lát cắt đầu tiên phục vụ tìm kiếm và đọc; chưa cấp quyền sửa ghi chú.

## Positioning

Giữ ghi chú Markdown trong brain cá nhân làm nguồn gốc. Người dùng chọn nguồn cho cuộc trao đổi và có thể mở lại đoạn nguồn đi kèm câu trả lời. Không coi một câu trả lời không có nguồn là nội dung đã được xác minh.

## Operating Context

- Công việc đã xác nhận: check issue của khách hàng; công cụ chính Helpdesk; ca trực theo Helpdesk Workshift, không có lịch tuần cố định được xác nhận.
- Brain hiện có: `/home/avada/avada-brain`, private remote `annvh/andrew-brain`. Không sao chép toàn vault vào app hoặc thay remote/history.
- Các nhóm tài liệu hiện có gồm inbox, daily, meeting, project, learning, guides và decisions. Markdown có frontmatter, headings, code, task list và wikilinks.
- App web local chạy riêng trong workspace Andrew TS Tools. Không có yêu cầu deploy công khai, service 24/7 hoặc channel nhắn tin.

## Capabilities and Constraints

### Confirmed scope

- Dùng brain cá nhân hiện có; connector chỉ đọc ở giai đoạn đầu.
- Notes/list, tìm kiếm và đọc nội dung; chọn nguồn để chuẩn bị trao đổi với trợ lý.
- Trợ lý ảo là mục tiêu sản phẩm; câu trả lời phải phân biệt nội dung có nguồn, suy luận và phần chưa biết.
- Provider chưa kết nối phải có trạng thái rõ. Không tạo câu trả lời giả hoặc tự ghi rằng người dùng đã chọn demo/UI-first.
- Không tự chạy AI khi mở app, đọc note hoặc đổi nguồn. Không tự sửa note, sync Git, tạo task Helpdesk, gọi bot hoặc huấn luyện.
- Không cài Hermes; không dùng adapter agent/action cũ như đường chat chỉ-thảo-luận khi chưa xác minh ràng buộc.
- Không đọc/đưa vào UI private, secrets, `.env`, credentials, auth, logs, agent sessions/memories hoặc merchant notes làm dữ liệu mẫu. Ví dụ thiết kế là dữ liệu minh họa được ghi nhãn.
- Không thay đổi TS Management, extension, các pipeline đang có, rules hoặc model/account/config của Codex.

### Open decisions

- Provider, model, credential/auth supported và quyền dùng dữ liệu đã chọn cho AI ngoài máy chưa được chốt.
- Chưa chọn UI-first hay kết nối AI thật ngay. Thiếu provider không cản slice đọc/tìm note; cũng không cho phép gọi một UI mock là AI thật.
- Quyền tạo/sửa/đổi tên/xóa note và chính sách lưu hội thoại chưa được duyệt; mặc định scope hiện tại không ghi vào brain.
- Cách sử dụng từ thiết bị khác, auth cho LAN/team hoặc đóng gói desktop không thuộc lựa chọn web local hiện tại.
- Tên hiển thị “Andrew Brain” là tên làm việc từ boundary/brain, chưa phải cam kết thương hiệu chính thức.

## Evidence on Hand

- Câu trả lời chọn phương án cá nhân + web local + React/TypeScript/Node + brain hiện có, đã được Hanlead xác nhận.
- Brain đã xác minh main `395f784ad16385670e7d98ed30bbe9a777f5ecb3`, private và clean trong discovery; các lần triển khai phải đối chiếu live lại.
- Có template daily/project/meeting/decision để hiểu schema; không dùng nội dung ghi chú riêng để tạo screenshot.
- Chưa có số đo hiệu quả, testimonial, lịch sử chat mới hoặc model response thực cho app này. Không bịa các bằng chứng đó.

## Product Principles

1. Giữ nguồn gốc đọc được: câu trả lời phải có đường quay lại nguồn đã chọn.
2. Đọc và tra cứu hữu ích ngay cả khi AI chưa kết nối.
3. Tách tài liệu nguồn khỏi output của trợ lý; không âm thầm sửa hoặc thay thế nguồn.
4. Chỉ thực hiện hành động người dùng chủ động chọn; trạng thái lỗi/chưa có quyền phải thành thật.
5. App mới độc lập với các luồng vận hành TS hiện có.

## Brand Commitments

Đại tá đã chọn hướng “Nguồn cạnh câu hỏi” (sources) qua chat bằng câu trả lời “1”. Dark là mặc định của bản đầu; developer-oriented nghĩa là gọn, hierarchy rõ, panels theo nhiệm vụ, code/metadata monospace và keyboard/focus tốt. Không terminal giả, neon trang trí hoặc metric/provider status bịa.
