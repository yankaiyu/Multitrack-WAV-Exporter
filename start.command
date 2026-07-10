#!/bin/bash
cd "$(dirname "$0")"
URL="http://127.0.0.1:8765"

# A previous launch may already be serving this local-only app. Reuse it instead
# of failing with “Address already in use”.
if /usr/bin/curl --silent --fail "$URL/api/status" >/dev/null 2>&1; then
  EXISTING_PID=$(/usr/sbin/lsof -t -nP -iTCP:8765 -sTCP:LISTEN 2>/dev/null | /usr/bin/head -n 1)
  /usr/bin/open "$URL"
  echo "Multitrack WAV Exporter is already running${EXISTING_PID:+ (PID $EXISTING_PID)}. Opened it in your browser."
  exit 0
fi

/usr/bin/python3 server.py &
SERVER_PID=$!

# Open the browser only after the server responds, rather than relying on a fixed delay.
for _ in {1..20}; do
  if /usr/bin/curl --silent --fail "$URL/api/status" >/dev/null 2>&1; then
    /usr/bin/open "$URL"
    wait "$SERVER_PID"
    exit $?
  fi
  sleep 0.25
done

echo "Could not start the local web server. The port may be used by another app."
wait "$SERVER_PID"
