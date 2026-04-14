#!/usr/bin/env bash
set -euo pipefail

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

MODE="${1:-reserve}"
if [[ $# -gt 0 ]]; then
  shift
fi

run_no_proxy() {
  env \
    -u http_proxy \
    -u https_proxy \
    -u HTTP_PROXY \
    -u HTTPS_PROXY \
    -u all_proxy \
    -u ALL_PROXY \
    -u npm_config_proxy \
    -u npm_config_https_proxy \
    NO_PROXY="*" \
    no_proxy="*" \
    "$@"
}

case "$MODE" in
  login)
    npm run login -- "$@"
    ;;
  inspect)
    npm run inspect -- "$@"
    ;;
  reserve)
    if [[ "${BUAA_DISABLE_PROXY:-0}" == "1" ]]; then
      run_no_proxy npm run reserve -- "$@"
    else
      npm run reserve -- "$@"
    fi
    ;;
  both)
    npm run login -- "$@"
    if [[ "${BUAA_DISABLE_PROXY:-0}" == "1" ]]; then
      run_no_proxy npm run reserve -- "$@"
    else
      npm run reserve -- "$@"
    fi
    ;;
  *)
    echo "用法: bash run.sh [login|reserve|inspect|both]"
    exit 1
    ;;
esac


# 生成数据
# npm run collect -- --count 1000 --delay 1000
