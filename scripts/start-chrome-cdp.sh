#!/usr/bin/env bash
set -euo pipefail

export DISPLAY="${DISPLAY:-:99}"
export CHROME_USER_DATA_DIR="${CHROME_USER_DATA_DIR:-/tmp/chrome-profile}"
export CHROME_REMOTE_DEBUGGING_ADDRESS="${CHROME_REMOTE_DEBUGGING_ADDRESS:-127.0.0.1}"
export CHROME_REMOTE_DEBUGGING_PORT="${CHROME_REMOTE_DEBUGGING_PORT:-9222}"
export CHROME_CDP_PROXY_ADDRESS="${CHROME_CDP_PROXY_ADDRESS:-0.0.0.0}"
export CHROME_CDP_PROXY_PORT="${CHROME_CDP_PROXY_PORT:-9223}"
export CHROME_WINDOW_SIZE="${CHROME_WINDOW_SIZE:-1280,800}"
export CHROME_URL="${CHROME_URL:-about:blank}"
CHROME_WINDOW_SIZE_FOR_CHROME="${CHROME_WINDOW_SIZE/x/,}"
XVFB_SCREEN_SIZE="${CHROME_WINDOW_SIZE/,/x}"

mkdir -p "$CHROME_USER_DATA_DIR" /tmp/.X11-unix

# This container owns its display. An abrupt reboot can leave these files behind;
# checking the old PID is unreliable because container restarts reuse PIDs.
display_number="${DISPLAY#:}"
display_number="${display_number%%.*}"
rm -f "/tmp/.X${display_number}-lock" "/tmp/.X11-unix/X${display_number}"
# Profiles are private to this sidecar. Chrome's singleton files can retain a
# previous container's hostname and prevent startup after recreation.
rm -f "$CHROME_USER_DATA_DIR/SingletonLock" "$CHROME_USER_DATA_DIR/SingletonCookie" "$CHROME_USER_DATA_DIR/SingletonSocket"

cleanup() {
  local pid
  for pid in "${chrome_pid:-}" "${nginx_pid:-}" "${xvfb_pid:-}"; do
    if [ -n "$pid" ]; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
  # Let Xvfb remove its socket and lock before the container exits.
  for pid in "${chrome_pid:-}" "${nginx_pid:-}" "${xvfb_pid:-}"; do
    if [ -n "$pid" ]; then
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 0' INT TERM

if command -v pulseaudio >/dev/null 2>&1; then
  pulseaudio --start --exit-idle-time=-1 || true
fi

# -displayfd signals when X clients can connect, avoiding a Chrome startup race.
rm -f /tmp/xvfb-ready
mkfifo -m 600 /tmp/xvfb-ready
exec 3<>/tmp/xvfb-ready
rm -f /tmp/xvfb-ready
Xvfb "$DISPLAY" -screen 0 "${XVFB_SCREEN_SIZE}x24" -ac +extension RANDR -displayfd 3 >/tmp/xvfb.log 2>&1 &
xvfb_pid="$!"
if ! read -r -t 15 ready_display <&3; then
  echo "Xvfb failed to become ready on $DISPLAY" >&2
  cat /tmp/xvfb.log >&2
  exit 1
fi
exec 3>&-

cat >/tmp/chrome-cdp-nginx.conf <<EOF
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events {}

http {
  access_log off;
  client_body_temp_path /tmp/nginx-client-body;
  proxy_temp_path /tmp/nginx-proxy;
  fastcgi_temp_path /tmp/nginx-fastcgi;
  uwsgi_temp_path /tmp/nginx-uwsgi;
  scgi_temp_path /tmp/nginx-scgi;

  server {
    listen ${CHROME_CDP_PROXY_ADDRESS}:${CHROME_CDP_PROXY_PORT};

    location / {
      proxy_http_version 1.1;
      proxy_set_header Host 127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT};
      proxy_set_header Upgrade \$http_upgrade;
      proxy_set_header Connection "upgrade";
      # Chrome reports its DevTools socket using the (rewritten) Host header, so
      # /json* responses contain ws://127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT}/...
      # which a remote client (e.g. the bot in another container) can't reach.
      # Rewrite it back to the address the client used so connectOverCDP's second
      # hop comes through this proxy. Disable upstream compression so sub_filter
      # can see the body.
      proxy_set_header Accept-Encoding "";
      sub_filter_types application/json;
      sub_filter_once off;
      sub_filter "127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT}" "\$http_host";
      proxy_pass http://127.0.0.1:${CHROME_REMOTE_DEBUGGING_PORT};
    }
  }
}
EOF

nginx -c /tmp/chrome-cdp-nginx.conf -g 'daemon off;' &
nginx_pid="$!"

google-chrome-stable \
  --remote-debugging-address="$CHROME_REMOTE_DEBUGGING_ADDRESS" \
  --remote-debugging-port="$CHROME_REMOTE_DEBUGGING_PORT" \
  --remote-allow-origins='*' \
  --user-data-dir="$CHROME_USER_DATA_DIR" \
  --window-size="$CHROME_WINDOW_SIZE_FOR_CHROME" \
  --window-position=0,0 \
  --force-device-scale-factor=1 \
  --auto-accept-this-tab-capture \
  --autoplay-policy=no-user-gesture-required \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --no-sandbox \
  "$CHROME_URL" &
chrome_pid="$!"

wait -n "$nginx_pid" "$chrome_pid" "$xvfb_pid"
