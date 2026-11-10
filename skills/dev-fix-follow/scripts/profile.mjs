// Profile of the dev-fix-follow skill: everything that distinguishes it from a
// sibling follow skill (feature-follow) sharing core/service/adapters/cli.
// Pure data, no imports, so core.mjs can use it as its default.
export const DEV_PROFILE = {
  name: 'dev-fix-follow',
  skillDir: 'skills/dev-fix-follow',
  runtimeDir: 'runtime/dev-fix-follow',
  logFile: 'runtime/dev-fix-follow.log',
  unit: 'andrew-dev-fix-follow',
  unitDescription: 'Hachimi dev-fix-follow: cap nhat tien do dev fix len ticket',
  enabledEnv: 'DEV_FIX_FOLLOW_ENABLED',
  tsStatus: 'dev_fixing',
  tsStatusLabel: 'Dev fixing',
  aiStatuses: {
    done: 'Dev báo done',
    awaiting_customer: 'Chờ khách cung cấp thông tin',
    awaiting_verification: 'Chờ kiểm tra/verify',
    awaiting_merge: 'Chờ review/merge',
    in_progress: 'Đang dev xử lý',
    blocked: 'Đang bị chặn',
    no_response: 'Dev chưa phản hồi',
    unknown: 'Chưa đủ dữ liệu để kết luận',
  },
  // Same prefixes as the former extension flow, so its drafts are recognised too.
  draftPrefix: { done: '[DRAFT — dev báo done', customer_info: '[DRAFT — dev chờ khách xác nhận' },
  progressPrefix: '[DEV FOLLOW |',
  customerRequestsTitle: 'Dev cần khách cung cấp:',
  trace: { source: 'dev-follow', subject: 'Cập nhật tiến độ dev fix', trigger: 'dev_fix_follow' },
  startText: 'Bắt đầu lượt cập nhật dev fix',
  telegramTitle: '🛠 Hachimi đã cập nhật tiến độ dev fix',
  lockMessage: 'Một lượt dev-fix-follow khác đang chạy.',
  disabledMessage: 'dev-fix-follow đang tắt (workflow.json enabled=false).',
};
