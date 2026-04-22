#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

show_help() {
  cat <<'EOF'
test-submit.sh 额外支持定时参数：
  --at TIME                 提交时间（Node.js 立即启动准备，到点发请求）。支持 "HH:MM[:SS]" 或 "YYYY-MM-DD HH:MM[:SS]"
  --delay-seconds N         延迟 N 秒后启动 Node.js（用于简单延迟，不如 --at 精确）

─── 五种模式 ────────────────────────────────────────────────────────────────
  predict（默认）           提前解验证码 + 规则预测 ID，到点直接提交（最快）
  poll                      提前解验证码 + 到点轮询 day/info 用真实 ID 提交
  predict-no-captcha        规则预测 ID，到点后才解验证码提交（07:00 开放推荐，避免跨天 token 失效）
  poll-no-captcha           到点后串行拉验证码+轮询 day/info，都就绪后提交
  predict-late-check        提前30s完成GET+OCR，到点后 CHECK+提交（兼顾速度与 07:00 token 安全，实验中）

─── 示例 ────────────────────────────────────────────────────────────────────
  # predict（默认，提前解验证码，规则推断 ID）
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-19 \
    --court '1号' --times '16:00-17:00,17:00-18:00' --with-captcha --day-info-mode predict --execute

  # predict-no-captcha（07:00 开放推荐：到点后才解验证码，避免 token 跨天失效）
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '4号' --times '16:00-17:00,17:00-18:00' --with-captcha --day-info-mode predict-no-captcha --execute

  # predict-late-check（07:00 实验：提前30s GET+OCR，到点后 CHECK，submit 约 07:00:01）
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '1号' --times '18:00-19:00' --with-captcha --day-info-mode predict-late-check --execute

  # poll（提前解验证码，到点后拉取真实 ID）
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00' --with-captcha --day-info-mode poll --execute

  # poll-no-captcha（到点后串行拉验证码+场地信息）
  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '2号' --times '07:00-08:00' --with-captcha --day-info-mode poll-no-captcha --execute

  # predict-no-captcha + 捡漏重试（推荐：07:00 抢不到时自动等捡漏）
  # 时间线：07:00 submit 失败 → 等30s → 解验证码 → 再等10s → 每隔1s轮询 day/info → 一旦有空位立即提交，全部售出则提前退出
  bash test-submit.sh --at "23:53:00" --account lys --date 2026-04-20 \
    --court '8号' --times '07:00-08:00' --with-captcha --day-info-mode predict-no-captcha \
    --retry-on-fail --execute

  bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '23号' --times '18:00-19:00,19:00-20:00' --with-captcha --day-info-mode predict-no-captcha --execute

─── 后台定时启动 ────────────────────────────────────────────────────────────
  nohup bash test-submit.sh --at "07:00:00" --account lys --date 2026-04-17 \
    --court '23号' --times '18:00-19:00' --with-captcha --day-info-mode predict-no-captcha --execute \
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
