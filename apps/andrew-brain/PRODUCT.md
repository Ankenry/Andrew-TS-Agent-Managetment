# Product

<!-- impeccable:product-schema 1 -->

## Platform

Linux desktop (GTK 3 + WebKitGTK), with the existing local web interface retained.

## Stack

React + TypeScript + Vite, với Node API riêng. Theo yêu cầu ngày 10/11/2026, bản desktop dùng GTK 3 + WebKitGTK, có icon dưới Home trên desktop và trong danh sách ứng dụng. Cửa sổ tự quản lý reader loopback riêng và không phụ thuộc service web. App có boundary độc lập tại `apps/andrew-brain`; không dùng chung server hoặc sửa giao diện TS Management.

## Users

Người dùng cá nhân: An, tên làm việc Andrew; Technical Support, team Customer Success. Không phải ứng dụng dùng chung cho cả team ở phạm vi hiện tại.

## Product Purpose

Một ứng dụng Second Brain và workspace cá nhân cho Andrew: tìm và đọc ghi chú, quản lý checklist cục bộ, duyệt file project và chat hai chiều với phiên Codex local đang kết nối qua Orca trong đúng workspace. Bố cục năm vùng được người dùng chỉ định ngày 10/11/2026. Kho ghi chú và source project vẫn chỉ đọc; AI theo nguồn chưa được kết nối.

## Positioning

Giữ ghi chú Markdown trong brain cá nhân làm nguồn gốc. Người dùng chọn nguồn cho cuộc trao đổi và có thể mở lại đoạn nguồn đi kèm câu trả lời. Không coi một câu trả lời không có nguồn là nội dung đã được xác minh.

## Operating Context

- Công việc đã xác nhận: check issue của khách hàng; công cụ chính Helpdesk; ca trực theo Helpdesk Workshift, không có lịch tuần cố định được xác nhận.
- Brain hiện có: `/home/avada/avada-brain`, private remote `annvh/andrew-brain`. Không sao chép toàn vault vào app hoặc thay remote/history.
- Các nhóm tài liệu hiện có gồm inbox, daily, meeting, project, learning, guides và decisions. Markdown có frontmatter, headings, code, task list và wikilinks.
- App web local chạy riêng trong workspace Andrew TS Tools. Không có yêu cầu deploy công khai, service 24/7 hoặc channel nhắn tin.

## Capabilities and Constraints

### Confirmed scope

- Theo ảnh `https://capture.avada.io/i/g4MUCONkt8Ra`: rail Work Space trái, agent strip trên, checklist giữa trái, khung chỉ thị agent giữa phải và folder/file phải. Giữ thư viện Brain làm view phụ và giữ palette hiện có.
- Checklist riêng được phép thêm và tick trong state app trên máy; không liên hệ Done/status Helpdesk hay sửa note.
- File project chỉ được duyệt/preview trong phạm vi đã xác định, bỏ secrets/runtime/dependencies/build và không theo symlink.
- Chat qua Orca chỉ gửi khi người dùng chọn agent và submit. Bind đúng terminal/process/workspace/native Codex session; không tạo agent hay tự gửi prompt. Đọc lịch sử và stream message công khai của đúng phiên đó; không đưa raw reasoning, system/developer messages hoặc tool logs vào UI. Hiển thị hoạt động thực và thời gian đang xử lý; input acceptance khác với hoàn thành. Kết nối lại không gửi lại; app chỉ lưu request hashes/IDs/status chống trùng, transcript vẫn thuộc Codex.

- Dùng brain cá nhân hiện có; connector chỉ đọc ở giai đoạn đầu.
- Notes/list, tìm kiếm và đọc nội dung; chọn nguồn để chuẩn bị trao đổi với trợ lý.
- Trợ lý ảo là mục tiêu sản phẩm; câu trả lời phải phân biệt nội dung có nguồn, suy luận và phần chưa biết.
- Provider chưa kết nối phải có trạng thái rõ. Không tạo câu trả lời giả hoặc tự ghi rằng người dùng đã chọn demo/UI-first.
- Không tự chạy AI khi mở app, đọc note hoặc đổi nguồn. Không tự sửa note, sync Git, tạo task Helpdesk, gọi bot hoặc huấn luyện.
- Không cài Hermes; không dùng adapter agent/action cũ như đường chat chỉ-thảo-luận khi chưa xác minh ràng buộc.
- Không đọc/đưa vào UI private, secrets, `.env`, credentials, auth, logs, agent memories, raw reasoning hoặc merchant notes làm dữ liệu mẫu. Chat chỉ đọc public messages của phiên Codex do người dùng chọn theo binding đã xác minh. Ví dụ thiết kế là dữ liệu minh họa được ghi nhãn.
- Không thay đổi TS Management, extension, các pipeline đang có, rules hoặc model/account/config của Codex.

### Open decisions

- Provider, model, credential/auth supported và quyền dùng dữ liệu đã chọn cho AI ngoài máy chưa được chốt.
- AI theo nguồn của Thư viện Brain chưa chọn provider; chat Workspace dùng chính Codex local đang chạy trong Orca, không cấu hình một provider hay account mới.
- Quyền tạo/sửa/đổi tên/xóa note và chính sách lưu hội thoại dài hạn chưa được duyệt. Checklist cục bộ và chỉ thị chủ động ở Workspace là phạm vi riêng đã yêu cầu ngày 10/11/2026; không ghi vào brain.
- Cách sử dụng từ thiết bị khác và auth cho LAN/team chưa được chọn. Desktop Linux đã được người dùng yêu cầu ngày 10/11/2026; phạm vi là cài cho tài khoản hiện tại, không phải phát hành đa nền tảng.
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

## Phiên Codex trong Workspace — 10/11/2026

Người dùng có thể sửa tên tab Orca bằng edit/pencil mà giữ đúng terminal/session, nhìn token context đã dùng/tổng ngay trên composer và chọn quyền/model/Fast dưới input. Controls chỉ gửi khi người dùng chọn, bind lại đúng native source, dùng catalog local và metadata của đúng phiên; không khởi tạo agent hoặc sửa model/account/permissions toàn cục. Native permissions vẫn có thể yêu cầu người dùng xác nhận trong Orca. Phân biệt accepted, pending và confirmed; không có telemetry thì hiện unknown. Thư viện Brain theo nguồn vẫn chưa cấu hình AI.
