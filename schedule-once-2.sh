#!/usr/bin/env bash
# 定时启动脚本：计算到目标时刻的等待时间，sleep 后执行命令
# 用法: nohup bash schedule-once-2.sh &
# 日志和 PID 会自动写到 schedule-once-2-${ACCOUNT}.log / .pid

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ACCOUNT="account2"
LOG_FILE="$SCRIPT_DIR/schedule-once-2-${ACCOUNT}.log"
PID_FILE="$SCRIPT_DIR/schedule-once-2-${ACCOUNT}.pid"

exec >> "$LOG_FILE" 2>&1

TARGET_TIME="06:59:32"
TARGET_DATE="2026-06-19"   # 模板日期：运行前改为需要启动的日期

TARGET_TS=$(date -j -f "%Y-%m-%d %H:%M:%S" "${TARGET_DATE} ${TARGET_TIME}" "+%s")
NOW_TS=$(date "+%s")
WAIT=$(( TARGET_TS - NOW_TS ))

if (( WAIT <= 0 )); then
  echo "[$(date '+%H:%M:%S')] 目标时刻 ${TARGET_DATE} ${TARGET_TIME} 已过，请检查日期"
  exit 1
fi

echo "[$(date '+%H:%M:%S')] 当前时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "[$(date '+%H:%M:%S')] 目标时间: ${TARGET_DATE} ${TARGET_TIME}（${WAIT}s 后）"
echo "[$(date '+%H:%M:%S')] 账号: ${ACCOUNT}，开始 sleep，进程 PID=$$"
echo "$$" > "$PID_FILE"

sleep "$WAIT"

echo "[$(date '+%H:%M:%S')] 启动 test-submit.sh ..."
bash "$SCRIPT_DIR/test-submit.sh" \
  --at "07:00:03" --account "$ACCOUNT" --date 2026-06-21 \
  --court '4号' --times '13:00-14:00,14:00-15:00' \
  --with-captcha --day-info-mode predict-no-captcha \
  --retry-on-fail \
  --retry-times '13:00-14:00,14:00-15:00,16:00-17:00,17:00-18:00,18:00-19:00,19:00-20:00,20:00-21:00,21:00-22:00' \
  --execute

echo "[$(date '+%H:%M:%S')] 完成"
rm -f "$PID_FILE"
