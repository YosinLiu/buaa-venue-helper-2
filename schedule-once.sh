#!/usr/bin/env bash
# 定时启动脚本：计算到目标时刻的等待时间，sleep 后执行命令
# 用法: nohup bash schedule-once.sh > schedule-once.log 2>&1 &

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET_TIME="06:59:30"
TARGET_DATE="2026-04-22"   # 明天

TARGET_TS=$(date -j -f "%Y-%m-%d %H:%M:%S" "${TARGET_DATE} ${TARGET_TIME}" "+%s")
NOW_TS=$(date "+%s")
WAIT=$(( TARGET_TS - NOW_TS ))

if (( WAIT <= 0 )); then
  echo "[$(date '+%H:%M:%S')] 目标时刻 ${TARGET_DATE} ${TARGET_TIME} 已过，请检查日期"
  exit 1
fi

echo "[$(date '+%H:%M:%S')] 当前时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "[$(date '+%H:%M:%S')] 目标时间: ${TARGET_DATE} ${TARGET_TIME}（${WAIT}s 后）"
echo "[$(date '+%H:%M:%S')] 开始 sleep，进程 PID=$$"
echo "$$" > "$SCRIPT_DIR/schedule-once.pid"

sleep "$WAIT"

echo "[$(date '+%H:%M:%S')] 启动 test-submit.sh ..."
bash "$SCRIPT_DIR/test-submit.sh" \
  --at "07:00:00" --account lys --date 2026-04-24 \
  --court '17号' --times '20:00-21:00,21:00-22:00' \
  --with-captcha --day-info-mode predict-no-captcha \
  --retry-on-fail \
  --retry-times '18:00-19:00,19:00-20:00,20:00-21:00,21:00-22:00' \
  --execute

echo "[$(date '+%H:%M:%S')] 完成"
rm -f "$SCRIPT_DIR/schedule-once.pid"
