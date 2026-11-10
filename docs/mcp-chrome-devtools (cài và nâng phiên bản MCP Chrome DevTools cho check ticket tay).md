# MCP Chrome DevTools — cài và nâng phiên bản

Dùng cho check ticket thủ công (Hancal, theo AGENTS.md "Ticket review workflow": headless, isolated, chỉ quan sát). Luồng check tự động (check-ticket-v2) không dùng MCP này mà dùng Playwright riêng.

## Cấu hình hiện tại (09/10/2026)
- Server `chrome-devtools` khai báo ở `~/.claude.json` → `projects["/home/avada/Andrew Tools CS-TS/Andrew TS Tools"].mcpServers.chrome-devtools` (scope local của Claude Code, không có `.mcp.json`):
  `/home/avada/.local/bin/chrome-devtools-mcp --headless --isolated --executablePath /usr/bin/google-chrome --no-usage-statistics`
- Gói cài global, ghim phiên bản: `npm i -g chrome-devtools-mcp@1.10.1` (vào `~/.local/lib/node_modules`, binary `~/.local/bin/chrome-devtools-mcp`). Khởi động 0,5 giây (initialize + tools/list 30 tool), không gọi mạng.

## Vì sao không dùng `npx -y chrome-devtools-mcp@latest`
`npx … @latest` hỏi registry npm mỗi lần khởi động dù gói đã có trong cache; khi DNS treo (như 16:12 ngày 09/10/2026, log notifier ghi `EAI_AGAIN`) npm chờ quá 30 giây và Claude Code báo `MCP server "chrome-devtools" connection timed out after 30000ms`. Ghim phiên bản hay `--prefer-offline` vẫn hỏi registry; chỉ `--offline` hoặc cài global mới tránh được.

## Nâng phiên bản
1. Xem bản mới: `npm view chrome-devtools-mcp version`.
2. `npm i -g chrome-devtools-mcp@<bản mới>` rồi `~/.local/bin/chrome-devtools-mcp --version`.
3. Đo: `node -e` gửi `initialize` + `tools/list` qua stdio (xem `scripts/`-độc lập: chạy binary với `--headless --isolated`, phải trả lời dưới 5 giây) hoặc `claude mcp list` → dòng `chrome-devtools … ✔ Connected`.
4. Phiên Claude Code đang mở chỉ nhận binary mới sau khi khởi động lại phiên hoặc `/mcp` → reconnect.

## Cài lại từ đầu / đổi lệnh
```
cp ~/.claude.json ~/.claude.json.bak-<ngày>
claude mcp remove chrome-devtools -s local
claude mcp add chrome-devtools -s local -- /home/avada/.local/bin/chrome-devtools-mcp --headless --isolated --executablePath /usr/bin/google-chrome --no-usage-statistics
claude mcp list
```
Chỉ đụng mục `mcpServers.chrome-devtools`; không đổi `permissions` hay mục khác. Chrome ở `/usr/bin/google-chrome` (bản 148); đổi đường dẫn nếu Chrome chuyển chỗ. Không bao giờ bỏ `--headless --isolated`: giữ Chrome của Đại tá và không mở cửa sổ nhìn thấy.

## Thay đổi
- 09/10/2026: Chuyển từ `npx -y chrome-devtools-mcp@latest` sang binary global ghim 1.10.1 (Hanbui, Hanlead duyệt phương án B theo lệnh Đại tá cho Hancal dùng MCP Chrome DevTools); sao lưu `~/.claude.json.bak-2026-10-09`.
