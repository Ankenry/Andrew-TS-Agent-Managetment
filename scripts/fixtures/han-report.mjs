import { HAN_REPORT_VERSION, reportArtifacts } from '../../skills/check-ticket/scripts/han-report.mjs';

export function hanFixture(body = 'Han đề xuất kiểm tra cấu hình; chưa thực hiện thay đổi.', category = 'Question') {
  return reportArtifacts({ version: HAN_REPORT_VERSION, category, sections: [
    `Han phân loại đây là ticket ${category} theo yêu cầu đã đọc.`,
    'Khách cần kiểm tra cấu hình hiển thị của ứng dụng.',
    'Han đã đối chiếu dữ liệu và nêu kết quả trong hướng xử lý.',
    body,
    'Cạ nhà lưu ý giới hạn kiểm chứng được nêu trong hướng xử lý.',
    'Han chưa có demo; cạ nhà cần đối chiếu cấu hình trước khi thay đổi.',
    'Han đã soạn báo cáo; Han chưa lưu thay đổi hoặc tạo demo.',
  ].map((body, i) => ({ id: i + 1, body })) });
}
