#!/usr/bin/env bash
set -euo pipefail

profile=${STA4593_WSL_PROFILE:-/home/orca/serve-profile}
app_root=${STA4593_WSL_APP_ROOT:-/home/orca/squashfs-root}
fixture_root=${STA4593_WSL_FIXTURE_ROOT:-$(cd "$(dirname "$0")" && pwd)}
ledger_path=${STA4593_LEDGER_PATH:-/tmp/sta4593-codex.jsonl}
port=${STA4593_WSL_PORT:-6873}

pkill -TERM -u orca || true
for _ in $(seq 1 50); do
	if ! pgrep -u orca >/dev/null; then
		break
	fi
	sleep 0.1
done
if pgrep -u orca >/dev/null; then
	pkill -KILL -u orca
fi

install -d -o orca -g orca -m 700 /home/orca/sta4593-bin
install -o orca -g orca -m 755 "$fixture_root/sta4593-fake-codex.py" \
	/home/orca/sta4593-bin/codex
rm -f "$profile/SingletonLock" "$profile/SingletonSocket" "$profile/SingletonCookie"
rm -f "$ledger_path" /home/orca/serve.log

setsid --fork runuser -u orca -- env \
	HOME=/home/orca \
	LIBGL_ALWAYS_SOFTWARE=1 \
	PATH=/home/orca/sta4593-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
	ORCA_STA4593_LEDGER="$ledger_path" \
	/bin/bash "$app_root/AppRun" \
	--user-data-dir="$profile" serve --port "$port" --json \
	</dev/null >>/home/orca/serve.log 2>&1

for _ in $(seq 1 120); do
	if ss -ltn | grep -q ":$port "; then
		exit 0
	fi
	sleep 0.25
done

tail -100 /home/orca/serve.log >&2
exit 1
