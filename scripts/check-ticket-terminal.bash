# Sourced by interactive ~/.bashrc. This viewer only reads state and local health.
checkticket-log() {
    command node '/home/avada/Andrew Tools CS-TS/Andrew TS Tools/scripts/check-ticket-terminal.mjs' "$@"
}
if [[ $- == *i* && -t 0 && -t 1 && ${TERM:-dumb} != dumb && ${CHECK_TICKET_LOG_AUTOSTART:-1} == 1 ]]; then
    if command -v node >/dev/null 2>&1; then
        checkticket-log
    fi
fi
