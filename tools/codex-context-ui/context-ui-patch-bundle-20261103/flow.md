# Context progress ngay trên composer Codex

## Trạng thái — 03/11/2026

**Candidate source, CHƯA full-build/activate.** Yêu cầu: một hàng context ngay trên ô nhập native Codex TUI; không phải footer `/statusline`, quota hay phần trăm hoàn thành task.

Source official `openai/codex`, tag `rust-v0.166.0`, commit `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`. `tools/codex-context-ui/source/` giữ pristine. Working tree riêng: `lock-candidate-20261103/`. Lock được duyệt SHA256 `360ea1e0ec391255ffc153a73548be524aa5d50c3476f247631cec184c21d4cb`; chỉ normalize 170 workspace identities theo manifest 0.166.0, không đổi external dependencies.

Snapshot trước sửa: `tools/codex-context-ui/patch-baseline-20261103/`, manifest SHA256 `9c75a96313b7d1897f323a206f1835920ffc1beb936df776ec7fb4fe559b1718`. Giữ bytes/mode/hash của candidate, các file tương ứng pristine, lock và custom profile. Không dùng git HEAD để bỏ thay đổi có sẵn.

## Nguồn dữ liệu và contract

`ThreadTokenUsageUpdated` hiện có → adapter `chatwidget/protocol.rs` → `ContextProgressState` trong `token_usage.rs` → snapshot nguyên tử → BottomPane/ChatComposer. Không polling, RPC mới, inference, đọc rollout/history/reasoning hoặc gọi Helpdesk.

- Used = `info.last_token_usage.tokens_in_context_window()`; không lấy `total_token_usage` tích lũy.
- Usable = `info.model_context_window` từ notification runtime; không suy từ config 872000, không hardcode 828400, không nhân 95% lần nữa.
- Remaining gọi **cùng** `TokenUsage::percent_of_context_window_remaining` với `/status`: helper native có baseline 12000. Không sao chép công thức vào renderer.
- `ContextProgressSnapshot` giữ đồng thời used/window/remaining. W thiếu/≤0 hoặc used<0 → `unknown`. U>W vẫn giữ số thực và native remaining0; W dương≤12000 giữ native remaining0.
- Format số dùng `status::format_tokens_compact`; mẫu fixture 191000/828400 → `191K/828K • 78% left`.
- Nếu `/status` tự dùng config fallback khi chưa có token event, thanh vẫn unknown: fallback không phải mẫu runtime đã xác minh.

## Lifecycle

Bind/resume session reset snapshot; replay không thiết lập capacity live. Adapter từ chối token notification sai thread trước shared resume handling. State chỉ nhận turn hiện tại; model thay đổi → unknown, chờ một turn live khác rồi token event của turn đó. Notification không có model ID nên đây là gate bảo thủ theo model/turn, không tuyên bố xác minh server model từ token event.

Compaction start → unknown; token mới thay mẫu; completion hiện đại không xóa mẫu mới. Legacy completion chỉ invalidate một lần cho turn tương ứng, không để completion trễ của turn cũ xóa mẫu hiện tại. Hai compaction hiện đại trong cùng turn vẫn invalidate ở mỗi start khác ID. Review giữ mẫu trước review riêng; trong review không dùng occupancy của review làm occupancy main; chỉ restore khi epoch/model chưa đổi. Clear/reset đưa về unknown.

## Layout và source

Các file thay nằm trong `codex-rs/tui/src/`:

- `token_usage.rs`: snapshot, lifecycle gate, tests thuần.
- `chatwidget.rs`, `chatwidget/{constructor,protocol,compaction,settings,session_flow}.rs`: binding/events/invalidation/forwarding.
- `bottom_pane/mod.rs`: truyền sample qua frame requester sẵn có.
- `bottom_pane/chat_composer.rs`, `chat_composer/{composer_layout,footer_state}.rs`: reserve1row chung cho height/render/cursor; popup overlay neo trên thanh.
- `chat_composer/context_progress.rs`: text/bar co theo width, giữ nhãn số nguyên vẹn, explicit unknown. Dùng native secondary style khi paint.
- Tests mới: `chat_composer/context_progress_tests.rs`, `chatwidget/tests/context_progress.rs`; test destructures cũ nhận thêm rectangle.

Thanh nằm ngay trước composer, dưới popup AboveComposer; overlay không đè thanh. Generic embedded editors không tự bật thanh. Nếu không còn tối thiểu input/voice rows an toàn thì ẩn thanh; input và footer hiện hành được ưu tiên. Pane hẹp rút nhãn/bar, có thể bỏ counts/bar khi không đủ chỗ; không cắt số thành số khác. Không stdout/ANSI injection vào PTY live.

## Kiểm chứng đã chạy và chưa chạy

Đã chạy: rustfmt stable1.95 `--check` trên các file thay (config `imports_granularity=Item` nightly bị stable bỏ qua và đã ghi warning); `git diff --check`; harness direct-rustc musl dùng **production modules nguyên byte** và rlib có sẵn, 7/7 test helper/lifecycle/text/native formatter PASS; guard7/7 process giả PASS. Harness trích nguyên function pure formatter từ source, lưu fragment/hash; không stub công thức hay copy thuật toán vào test. Không chạy Cargo/dependency compile trong lượt patch này.

Chưa chạy: compile/typecheck toàn ChatWidget/composer, các test integration mới, regression snapshots, VT100 matrix, full CLI smoke/startup/protocol/companion parity, live PTY/resize. Suite đã viết nhưng không tính là PASS. Cached metadata cho thấy test TUI kéo core/app-server và thiếu rlib; chạy cargo test/check sẽ thành full dependency build, nên chưa chạy. Sau khi có RAM cần review các snapshot cũ thay đổi do hàng unknown mới; không auto-accept hàng loạt.

Full CLI attempt trước patch đã dừng17:43:01 UTC+7 bởi proactive MemAvailable2.25GiB guard (đo2.244GiB, còn trên reserve2GiB). Không có deployable binary. Peak RSS quan sát từ lúc reattach2.258GiB; **không phải peak toàn lần build** do guard cũ có gap khi du gặp ENOENT. Evidence gốc giữ nguyên, không lấp gap bằng test guard mới.

Guard mới `tmp/task-build-guard.py` giữ Popen parent, scan footprint ngoài sampling path, xử lý file biến mất và fail-closed lỗi khác, luôn wait/reap child và ghi actual exit/guard reason. Đã thay runner task-local dùng guard; marker một lần cũ vẫn giữ và không chạy lại. Không đóng app/agent khác, thêm swap hoặc đổi host.

## Build, bundle và phần còn lại

`tools/codex-context-ui/context-ui-patch-bundle-20261103/` chứa diff/manifest/hướng dẫn, không credentials/conversation/profile. Chưa upload.

Profile riêng task: release lto=false (không cross-crate LTO; local thin LTO có thể còn), codegen-units64, debug0, core opt1; package khác opt3. Giữ release assertions/overflow/panic/features/sandbox. Đây là custom build, không official/reproducible release; hiệu năng/kích thước chưa benchmark, mất source-line debug info.

Cần tiếp theo khi có tài nguyên và phê duyệt cửa sổ build: xác minh source/lock/profile hashes; smoke unpatched normalization-lock source trước; build patched binary cùng profile; chạy focused và regression TUI suite, kiểm artifacts companion/bwrap/V8, version/help/schema không inference; kiểm native layout/PTY fixtures. Chỉ sau PASS mới trình rollout riêng.

Rollout chưa được duyệt: giữ Codex/Orca/global launcher và runtime Hanlead hiện có; `.codex/config.toml=872000` giữ nguyên. Không bật context-meter legacy. Phương án sau duyệt: graceful resume đúng UUID trong tab/cwd cũ bằng local binary + context override, kiểm bar và `/status` cùng mẫu; rollback bằng installed binary cũ, cùng UUID/flags, không reset/overwrite hội thoại hoặc dữ liệu.
