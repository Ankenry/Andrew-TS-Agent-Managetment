#!/usr/bin/env bash
# OPTIONAL. The tracing web already has a friendly address that needs no setup: http://andrewtstracing.localhost:5077
# This script adds a custom domain without a port, e.g. http://andrewtstracing.com (this machine only, nothing is published).
# After installing, set HACHIMI_TRACE_WEB_DOMAIN=<domain> in .env_my so the server accepts that name.
#   sudo bash scripts/install-hachimi-trace-domain.sh              # install / repair
#   sudo bash scripts/install-hachimi-trace-domain.sh --uninstall  # remove
#   sudo bash scripts/install-hachimi-trace-domain.sh --domain mytrace.test --port 5077
# What it changes (all reversible with --uninstall):
#   1. /etc/hosts            one line "127.0.0.77 <domain> www.<domain>" (backup: /etc/hosts.hachimi-trace.bak)
#   2. systemd system units  andrew-hachimi-trace-domain.socket/.service: listens on 127.0.0.77:80 (loopback only)
#                            and forwards to the tracing web on 127.0.0.1:<port>.
set -euo pipefail

DOMAIN="andrewtstracing.com"; PORT="5077"; ADDRESS="127.0.0.77"; ACTION="install"
UNIT="andrew-hachimi-trace-domain"; MARK="# Hachimi Trace local domain"
PROXY="/usr/lib/systemd/systemd-socket-proxyd"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --uninstall) ACTION="uninstall"; shift ;;
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    -h|--help) sed -n 2,13p "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

DOMAIN="$(printf '%s' "$DOMAIN" | tr '[:upper:]' '[:lower:]')"
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || { echo "Invalid domain: $DOMAIN" >&2; exit 2; }
[[ "$PORT" =~ ^[0-9]{2,5}$ && "$PORT" -ge 1024 && "$PORT" -le 65535 ]] || { echo "Invalid port: $PORT" >&2; exit 2; }
[[ $EUID -eq 0 ]] || { echo "Cần quyền root: sudo bash $0 $*" >&2; exit 1; }

remove_hosts_entry() {
  if grep -qF "$MARK" /etc/hosts; then
    local tmp; tmp="$(mktemp)"
    grep -vF "$MARK" /etc/hosts > "$tmp"
    cat "$tmp" > /etc/hosts   # keep inode, owner and mode of /etc/hosts
    rm -f "$tmp"
  fi
}

if [[ "$ACTION" == "uninstall" ]]; then
  systemctl disable --now "$UNIT.socket" "$UNIT.service" 2>/dev/null || true
  rm -f "/etc/systemd/system/$UNIT.socket" "/etc/systemd/system/$UNIT.service"
  systemctl daemon-reload
  remove_hosts_entry
  echo "Đã gỡ domain local. Web tracing vẫn chạy tại http://127.0.0.1:$PORT"
  exit 0
fi

[[ -x "$PROXY" ]] || { echo "Không tìm thấy $PROXY (systemd-socket-proxyd)." >&2; exit 1; }
if ss -ltn 2>/dev/null | awk '{print $4}' | grep -qx "0.0.0.0:80\|\*:80\|\[::\]:80"; then
  echo "Cổng 80 đang được một dịch vụ khác lắng nghe trên mọi địa chỉ; không thể dùng $ADDRESS:80." >&2; exit 1
fi

[[ -e /etc/hosts.hachimi-trace.bak ]] || cp -p /etc/hosts /etc/hosts.hachimi-trace.bak
remove_hosts_entry
printf '%s %s www.%s %s\n' "$ADDRESS" "$DOMAIN" "$DOMAIN" "$MARK" >> /etc/hosts

cat > "/etc/systemd/system/$UNIT.socket" <<UNITEOF
[Unit]
Description=Hachimi Trace local domain (http://$DOMAIN -> 127.0.0.1:$PORT)

[Socket]
ListenStream=$ADDRESS:80
NoDelay=true

[Install]
WantedBy=sockets.target
UNITEOF

cat > "/etc/systemd/system/$UNIT.service" <<UNITEOF
[Unit]
Description=Forward http://$DOMAIN to the Hachimi tracing web (127.0.0.1:$PORT)
Requires=$UNIT.socket
After=$UNIT.socket

[Service]
ExecStart=$PROXY 127.0.0.1:$PORT
DynamicUser=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
NoNewPrivileges=yes
UNITEOF

systemctl daemon-reload
systemctl enable "$UNIT.socket" >/dev/null
systemctl restart "$UNIT.socket"

sleep 0.5
if command -v curl >/dev/null && curl -fsS -m 4 "http://$DOMAIN/api/health" | grep -q '"service":"hachimi-trace-web"'; then
  echo "Xong: http://$DOMAIN đang trỏ về web tracing local (127.0.0.1:$PORT)."
else
  echo "Đã cài domain, nhưng http://$DOMAIN/api/health chưa trả lời. Kiểm tra web tracing: systemctl --user status andrew-hachimi-trace-web.service" >&2
  exit 1
fi
