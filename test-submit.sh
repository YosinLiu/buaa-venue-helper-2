#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

show_help() {
  cat <<'EOF'
test-submit.sh 额外支持定时参数：
  --at TIME                 提交时间（Node.js 立即启动准备，到点发请求）。支持 "HH:MM[:SS]" 或 "YYYY-MM-DD HH:MM[:SS]"
  --delay-seconds N         延迟 N 秒后启动 Node.js（用于简单延迟，不如 --at 精确）

─── 三种 day/info 模式 ──────────────────────────────────────────────────────
  (默认 pre)               --at 前并行拉 captcha + day/info + buddies，到点直接发
  --day-info-mode poll     --at 前只取 captcha + buddies，到点后轮询 day/info（适合数据 7:00 才开放的情况）
  --day-info-mode predict  不查 day/info，按 timeId 每日递增规律预测，最快

─── 示例（1 个时间段）────────────────────────────────────────────────────────
  # 默认 pre 模式
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00' --with-captcha --execute

  # poll 模式（day/info 7:00 后才有数据时推荐）
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00' --with-captcha --day-info-mode poll --execute

  # predict 模式（最快，无需查 day/info）
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00' --with-captcha --day-info-mode predict --execute

─── 示例（2 个时间段）────────────────────────────────────────────────────────
  # 默认 pre 模式
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00,08:00-09:00' --with-captcha --execute

  # poll 模式
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00,08:00-09:00' --with-captcha --day-info-mode poll --execute

  # predict 模式
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00,08:00-09:00' --with-captcha --day-info-mode predict --execute

─── 后台定时启动 ────────────────────────────────────────────────────────────
  nohup bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00' --with-captcha --day-info-mode predict --execute \
    > test-submit-timer.log 2>&1 &

─── 首次使用或登录状态过期 ──────────────────────────────────────────────────
  bash test-submit.sh --save-auth --account lys --headless

下面是 test-submit.js 的参数：
EOF
  node test-submit.js --help
}

delay_seconds=""
pass_args=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delay-seconds|--delay)
      delay_seconds="${2:?--delay-seconds 需要一个秒数}"
      shift 2
      ;;
    --delay-seconds=*|--delay=*)
      delay_seconds="${1#*=}"
      shift
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    --)
      shift
      pass_args+=("$@")
      break
      ;;
    *)
      pass_args+=("$1")
      shift
      ;;
  esac
done

# --delay-seconds 在 bash 层处理（粗粒度延迟启动）
if [[ -n "$delay_seconds" ]]; then
  if ! [[ "$delay_seconds" =~ ^[0-9]+$ ]]; then
    echo "--delay-seconds 必须是非负整数"
    exit 1
  fi
  if (( delay_seconds > 0 )); then
    echo "延迟 ${delay_seconds}s 后启动..."
    sleep "$delay_seconds"
  fi
fi

# --at 直接传给 Node.js，由 Node.js 处理精确定时和预热
node test-submit.js "${pass_args[@]}"
