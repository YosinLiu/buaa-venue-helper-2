#!/usr/bin/env bash
# 单次整点任务模板：通过环境变量指定账号、流程开始时刻和预约日期。
# 首轮固定为 1 号场 20:00–22:00；补抢同一时段，允许单小时降级。
# 日常双账号任务请使用 run-daily.sh。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

: "${ACCOUNT:?请设置 ACCOUNT 为 config.json 中的账号名}"
: "${START_AT:?请设置 START_AT，例如 YYYY-MM-DD 07:00:00}"
: "${TARGET_DATE:?请设置 TARGET_DATE，例如 YYYY-MM-DD}"
RUN_DATE="${START_AT%% *}"
LOG_DIR="$SCRIPT_DIR/logs"
LOG_FILE="$LOG_DIR/formal-${RUN_DATE}-${ACCOUNT}.log"
PID_FILE="$SCRIPT_DIR/formal-${RUN_DATE}-${ACCOUNT}.pid"
CHILD_PID=""

mkdir -p "$LOG_DIR"
umask 077

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "任务已经在运行，PID=$EXISTING_PID"
    echo "日志：$LOG_FILE"
    exit 1
  fi
  rm -f "$PID_FILE"
fi

TARGET_TS="$(date -j -f "%Y-%m-%d %H:%M:%S" "$START_AT" "+%s")"
NOW_TS="$(date "+%s")"
if (( TARGET_TS <= NOW_TS )); then
  echo "目标开始时刻 $START_AT 已经过期，拒绝立即执行。"
  exit 1
fi

cleanup() {
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}
trap cleanup EXIT INT TERM

exec >> "$LOG_FILE" 2>&1
echo ""
echo "════════════════ 正式预约任务 ════════════════"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 调度进程启动，PID=$$"
echo "账号: $ACCOUNT"
echo "流程开始: $START_AT"
echo "预约目标: ${TARGET_DATE}，首轮 1号场 20:00-22:00"
echo "补抢策略: 开始后 +90s 获取验证码；+120s 优先任一同场连续两小时，否则任一目标小时；最多补交一次"
echo "日志: $LOG_FILE"
echo "$$" > "$PID_FILE"

caffeinate -dims bash "$SCRIPT_DIR/test-submit.sh" \
  --start-at "$START_AT" \
  --min-flow-duration-ms 6000 \
  --account "$ACCOUNT" \
  --date "$TARGET_DATE" \
  --venue-site-id 38 \
  --court '1号' \
  --times '20:00-21:00,21:00-22:00' \
  --with-captcha \
  --day-info-mode predict \
  --submit-attempts 1 \
  --retry-on-fail \
  --retry-captcha-delay-ms 90000 \
  --retry-poll-delay-ms 120000 \
  --retry-window-ms 200000 \
  --retry-poll-ms 1000 \
  --retry-times '20:00-21:00,21:00-22:00' \
  --retry-any-court \
  --retry-max-slots 2 \
  --retry-require-all \
  --retry-fallback-single \
  --retry-submit-attempts 1 \
  --execute &

CHILD_PID=$!
if wait "$CHILD_PID"; then
  EXIT_CODE=0
else
  EXIT_CODE=$?
fi
CHILD_PID=""
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 任务结束，退出码=$EXIT_CODE"
exit "$EXIT_CODE"
