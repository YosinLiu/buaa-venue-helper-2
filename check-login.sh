#!/usr/bin/env bash

# bash check-login.sh jyt      # 检查 jyt 账号登录态
# bash check-login.sh          # 列出所有账号 + 对应 profile
# bash check-login.sh --help   # 帮助



set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

show_help() {
  cat <<'EOF'
check-login.sh <账号名>

  用指定账号的 profile 打开预约页面，检查登录态是否有效。

  - 直接看到场地预约页面（没弹登录）→ token 有效 ✅
  - 跳到统一身份认证登录页面        → token 失效，需重新登录 ❌

  检查完直接关闭浏览器窗口即可（不要 Ctrl+C）。

示例：
  bash check-login.sh jyt
  bash check-login.sh           # 不带参数：列出 config.json 里所有账号
EOF
}

case "${1:-}" in
  -h|--help)
    show_help
    exit 0
    ;;
esac

ACCOUNT="${1:-}"

# 不带账号名 → 列出 config.json 里所有账号及其 profile
if [[ -z "$ACCOUNT" ]]; then
  echo "config.json 里的账号："
  node -e "
    const c = require('./config.json');
    const def = c.userDataDir || '.playwright-profile';
    for (const a of (c.accounts || [])) {
      console.log('  ' + (a.name || '?').padEnd(8) + ' → ' + (a.userDataDir || def));
    }
  "
  echo ""
  echo "用法： bash check-login.sh <账号名>"
  exit 0
fi

# 用 config.json 解析该账号的 profile 目录、可执行文件路径、预约页面 URL
node -e "
const path = require('path');
const { chromium } = require('playwright');
const c = require('./config.json');

const name = process.argv[1];
const acc = (c.accounts || []).find(a => a.name === name);
if (!acc) {
  console.error('❌ config.json 里找不到账号: ' + name);
  console.error('   可用账号: ' + (c.accounts || []).map(a => a.name).join(', '));
  process.exit(1);
}

const profileDir = acc.userDataDir || c.userDataDir || '.playwright-profile';
const url = c.url || 'https://cgyy.buaa.edu.cn/venue/venue-reservation/38';

(async () => {
  const opts = {
    headless: false,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: null,
    args: ['--start-maximized'],
  };
  if (c.browserExecutablePath) opts.executablePath = c.browserExecutablePath;

  const ctx = await chromium.launchPersistentContext(path.resolve(profileDir), opts);
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(url);
  console.log('>>> ' + name + ' 账号已打开页面 (profile: ' + profileDir + ')');
  console.log('>>> 直接看到场地预约页面 = 账号可用 ✅');
  console.log('>>> 跳到登录页 = token 失效，需重新登录 ❌');
  console.log('>>> 验证完后直接关闭浏览器窗口（不要 Ctrl+C）');
  await ctx.waitForEvent('close', { timeout: 0 });
})();
" "$ACCOUNT"
