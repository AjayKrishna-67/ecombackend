#!/usr/bin/env bash
# Starts local Vendure (server + worker) and the Razorpay test console with every
# outbound message channel switched OFF, so test orders never SMS / WhatsApp /
# email anyone (customers or the staff alert numbers on shipping methods).
#
#   bash static/test/razorpay-console/start.sh            # server + worker + console
#   bash static/test/razorpay-console/start.sh --no-worker # server + console only
#                                                           # (webhook tests need the worker)
#
# How "off" works: every sender reads its credentials from env and skips (MSG91) or
# cannot connect (SMTP) when they are blank. Variables exported here win over .env:
# neither Bun's .env loader nor `import 'dotenv/config'` overwrites a variable that
# is already set, even to an empty string.
#
# Stop your usual dev server/worker first (same port). Ctrl+C stops everything.
set -euo pipefail
cd "$(dirname "$0")/../../.."

# --- Messages OFF -----------------------------------------------------------
export MSG91_AUTH_KEY=                      # order SMS, order/staff WhatsApp, cancel + abandoned-cart WhatsApp
export SMTP_HOST=127.0.0.1 SMTP_PORT=9 SMTP_USERNAME= SMTP_PASSWORD=   # EmailPlugin
export SOUTHMITHAI_SMTP_HOST=127.0.0.1 SOUTHMITHAI_SMTP_PORT=9 SOUTHMITHAI_SMTP_USERNAME= SOUTHMITHAI_SMTP_PASSWORD=
export SWADKERALA_SMTP_HOST=127.0.0.1 SWADKERALA_SMTP_PORT=9 SWADKERALA_SMTP_USERNAME= SWADKERALA_SMTP_PASSWORD=
export ORDER_PLACED_WEBHOOK_URL=            # Razorpay plugin's outgoing "order placed" webhook
export VENDURE_DISABLE_TELEMETRY=true       # Vendure's anonymous usage ping
export RZP_CONSOLE_SAFE=1                   # lets the console confirm it was started this way

PORT_FROM_ENV=$(grep -E '^PORT=' .env | head -1 | cut -d= -f2- | tr -d "\"'" || true)
VENDURE_PORT=${PORT:-${PORT_FROM_ENV:-3000}}
if (exec 3<>"/dev/tcp/127.0.0.1/${VENDURE_PORT}") 2>/dev/null; then
    echo "Port ${VENDURE_PORT} is already in use. Stop your running dev server/worker first, then re-run." >&2
    exit 1
fi

trap 'echo; echo "Stopping..."; kill 0' EXIT INT TERM
echo "Messages OFF: MSG91_AUTH_KEY, SMTP creds, ORDER_PLACED_WEBHOOK_URL blanked; telemetry disabled."

bun run dev:server &
if [[ "${1:-}" != "--no-worker" ]]; then
    bun run dev:worker &
fi
VENDURE_URL="http://localhost:${VENDURE_PORT}" bun static/test/razorpay-console/server.ts &
echo "Console: http://localhost:${RZP_CONSOLE_PORT:-4545}  (Vendure boot takes ~30-60 s)"
wait
