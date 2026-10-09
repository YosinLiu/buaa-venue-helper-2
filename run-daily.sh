#!/usr/bin/env bash
# 每日正式任务入口，由 launchd 在 06:50 启动。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PRIMARY_ACCOUNT="account1"
SECONDARY_ACCOUNT="account2"
PRIMARY_START_OFFSET_MS=0
SECONDARY_START_OFFSET_MS=300
PRIMARY_COURT="1号"
PRIMARY_TIMES="20:00-21:00,21:00-22:00"
SECONDARY_COURT="2号"
SECONDARY_TIMES="18:00-19:00,19:00-20:00"
# 两个账号均在晚间窗口内补抢任意场地的连续两小时。
RETRY_TIMES="18:00-19:00,19:00-20:00,20:00-21:00,21:00-22:00"
RETRY_ANY_COURT=1
MIN_FLOW_DURATION_MS=5900
SERVER_SAFETY_DELAY_MS=0

# 真实账号和本机 Node 路径放在 Git 忽略的私有文件中。
if [[ -f "$SCRIPT_DIR/run-daily.local.sh" ]]; then
  source "$SCRIPT_DIR/run-daily.local.sh"
fi
export PATH="${NODE_BIN_DIR:+$NODE_BIN_DIR:}/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

RUN_DATE="$(date '+%Y-%m-%d')"
START_AT="${RUN_DATE} 07:00:00"
TARGET_DATE="$(date -v+2d '+%Y-%m-%d')"
LOG_DIR="$SCRIPT_DIR/logs"
PID_FILE="$SCRIPT_DIR/formal-daily-multi.pid"
CHILD_PIDS=()

mkdir -p "$LOG_DIR"
umask 077

if [[ "${1:-}" == "--check" ]]; then
  echo "账号1: ${PRIMARY_ACCOUNT}（错峰 +${PRIMARY_START_OFFSET_MS}ms）"
  echo "  首轮: 主馆${PRIMARY_COURT}场 ${PRIMARY_TIMES}"
  echo "账号2: ${SECONDARY_ACCOUNT}（错峰 +${SECONDARY_START_OFFSET_MS}ms）"
  echo "  首轮: 主馆${SECONDARY_COURT}场 ${SECONDARY_TIMES}"
  echo "开始时间: $START_AT"
  echo "服务器时间额外缓冲: ${SERVER_SAFETY_DELAY_MS}ms"
  echo "最短流程门槛: ${MIN_FLOW_DURATION_MS}ms"
  echo "预约日期: $TARGET_DATE"
  if [[ "$RETRY_ANY_COURT" == "1" ]]; then
    echo "账号1补抢: 主馆任意场地（1-12号）${RETRY_TIMES}，窗口内选同场连续两小时"
    echo "账号2补抢: 主馆任意场地（1-12号）${RETRY_TIMES}，窗口内选同场连续两小时"
  else
    echo "账号1补抢: 主馆${PRIMARY_COURT}场 ${RETRY_TIMES}，窗口内选同场连续两小时"
    echo "账号2补抢: 主馆${SECONDARY_COURT}场 ${RETRY_TIMES}，窗口内选同场连续两小时"
  fi
  echo "日志: $LOG_DIR/formal-${RUN_DATE}-<账号>.log"
  exit 0
fi

# launchd 若因睡眠延迟到 07:00:15 以后才唤起，拒绝迟到下单。
NOW_TS="$(date '+%s')"
START_TS="$(date -j -f '%Y-%m-%d %H:%M:%S' "$START_AT" '+%s')"
if (( NOW_TS > START_TS + 15 )); then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] 已超过 07:00:15，拒绝迟到执行。"
  exit 1
fi

if [[ -f "$PID_FILE" ]]; then
  EXISTING_PID="$(tr -cd '0-9' < "$PID_FILE")"
  if [[ -n "$EXISTING_PID" ]] && kill -0 "$EXISTING_PID" 2>/dev/null; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 每日任务已运行，PID=$EXISTING_PID"
    exit 1
  fi
  rm -f "$PID_FILE"
fi

cleanup() {
  for pid in "${CHILD_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  rm -f "$PID_FILE"
}
trap cleanup EXIT INT TERM

echo "$$" > "$PID_FILE"

account_is_ready() {
  local account="$1"
  node -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync("config.json", "utf8"));
    const a = (c.accounts || []).find((item) => item.name === process.argv[1]);
    if (!a || a.enabled === false || !a.phone || !Array.isArray(a.buddyIds) || a.buddyIds.length === 0) process.exit(1);
    const auth = `${a.userDataDir || `.playwright-profile-${a.name}`}-auth.json`;
    if (!fs.existsSync(auth)) process.exit(1);
  ' "$account"
}

run_account() {
  local account="$1"
  local start_offset_ms="$2"
  local court="$3"
  local times="$4"
  local log_file="$LOG_DIR/formal-${RUN_DATE}-${account}.log"
  local retry_scope_args=()
  if [[ "$RETRY_ANY_COURT" == "1" ]]; then
    retry_scope_args=(--retry-any-court)
  else
    retry_scope_args=(--retry-court "$court")
  fi

  if ! account_is_ready "$account"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 跳过账号 $account：账号未启用、预约资料不完整或登录态缺失。" >> "$log_file"
    return 0
  fi

  {
    echo ""
    echo "════════════════ 每日正式预约任务 ════════════════"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 双账号调度启动，父 PID=$$"
    echo "账号: $account"
    echo "流程开始: $START_AT + ${start_offset_ms}ms"
    echo "预计最早发单: $START_AT + $((start_offset_ms + MIN_FLOW_DURATION_MS))ms"
    echo "最短流程门槛: ${MIN_FLOW_DURATION_MS}ms"
    echo "预约目标: ${TARGET_DATE}，首轮 主馆${court}场 ${times}"
    if [[ "$RETRY_ANY_COURT" == "1" ]]; then
      echo "补抢: 首轮基准 +90s 验证码；+120s 在主馆任意场地（1-12号）${RETRY_TIMES}，窗口内选同场连续两小时"
    else
      echo "补抢: 首轮基准 +90s 验证码；+120s 在主馆${court}场 ${RETRY_TIMES}，窗口内选同场连续两小时"
    fi
  } >> "$log_file"

  /usr/bin/caffeinate -dims bash "$SCRIPT_DIR/test-submit.sh" \
    --start-at "$START_AT" \
    --start-offset-ms "$start_offset_ms" \
    --server-safety-delay-ms "$SERVER_SAFETY_DELAY_MS" \
    --min-flow-duration-ms "$MIN_FLOW_DURATION_MS" \
    --account "$account" \
    --date "$TARGET_DATE" \
    --venue-site-id 38 \
    --court "$court" \
    --times "$times" \
    --with-captcha \
    --day-info-mode predict \
    --submit-attempts 1 \
    --retry-on-fail \
    --retry-captcha-delay-ms 90000 \
    --retry-poll-delay-ms 120000 \
    --retry-window-ms 200000 \
    --retry-poll-ms 3000 \
    --retry-times "$RETRY_TIMES" \
    "${retry_scope_args[@]}" \
    --retry-max-slots 2 \
    --retry-require-consecutive-two \
    --retry-submit-attempts 1 \
    --execute >> "$log_file" 2>&1
}

run_account "$PRIMARY_ACCOUNT" "$PRIMARY_START_OFFSET_MS" "$PRIMARY_COURT" "$PRIMARY_TIMES" &
CHILD_PIDS+=("$!")
run_account "$SECONDARY_ACCOUNT" "$SECONDARY_START_OFFSET_MS" "$SECONDARY_COURT" "$SECONDARY_TIMES" &
CHILD_PIDS+=("$!")

EXIT_CODE=0
for pid in "${CHILD_PIDS[@]}"; do
  if ! wait "$pid"; then
    EXIT_CODE=1
  fi
done
CHILD_PIDS=()
exit "$EXIT_CODE"
