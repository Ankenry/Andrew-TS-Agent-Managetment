// Profile of the feature-follow skill. The code lives in skills/dev-fix-follow
// (core, service, adapters, cli); this file only states what differs: the
// ticket status, the status labels, the comment prefixes and the paths.
export const FEATURE_PROFILE = {
  name: 'feature-follow',
  skillDir: 'skills/feature-follow',
  runtimeDir: 'runtime/feature-follow',
  logFile: 'runtime/feature-follow.log',
  unit: 'andrew-feature-follow',
  unitDescription: 'Hachimi feature-follow: cap nhat tien do feature request len ticket',
  enabledEnv: 'FEATURE_FOLLOW_ENABLED',
  tsStatus: 'feature_request',
  tsStatusLabel: 'Feature request',
  aiStatuses: {
    done: 'Feature đã release',
    awaiting_customer: 'Chờ khách cung cấp thông tin',
    awaiting_verification: 'Đã release, chờ kiểm tra',
    awaiting_merge: 'Chờ review/release',
    in_progress: 'Đang phát triển',
    acknowledged: 'Dev/PM đã nhận yêu cầu',
    declined: 'Dev/PM từ chối hoặc chưa làm',
    blocked: 'Đang bị chặn',
    no_response: 'Dev/PM chưa phản hồi',
    unknown: 'Chưa đủ dữ liệu để kết luận',
  },
  draftPrefix: { done: '[DRAFT — feature đã release', customer_info: '[DRAFT — feature chờ khách xác nhận' },
  progressPrefix: '[FEATURE FOLLOW |',
  customerRequestsTitle: 'Dev/PM cần khách cung cấp:',
  trace: { source: 'feature-follow', subject: 'Cập nhật tiến độ feature request', trigger: 'feature_follow' },
  startText: 'Bắt đầu lượt cập nhật feature request',
  telegramTitle: '✨ Hachimi đã cập nhật tiến độ feature request',
  lockMessage: 'Một lượt feature-follow khác đang chạy.',
  disabledMessage: 'feature-follow đang tắt (workflow.json enabled=false).',
};
