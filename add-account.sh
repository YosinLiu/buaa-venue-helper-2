#!/usr/bin/env bash
set -euo pipefail

# add-account.sh <账号名>
#
#   一条命令完成「新增一个抢场账号」的全流程：
#     1) 用新 profile 打开登录页，你在浏览器里登录后关闭窗口
#     2) 提示输入手机号 / 同伴，写进 config.json
#     3) 跑 test-submit.sh --save-auth 保存登录态到 .playwright-profile-<name>-auth.json
#
#   用法：
#     bash add-account.sh 2601
#     bash add-account.sh --help

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

case "${1:-}" in
  -h|--help|"")
    cat <<'EOF'
add-account.sh <账号名>

  新增一个抢场账号的完整流程（登录 → 写 config → 保存登录态）。

  bash add-account.sh 2601      # 新建名为 2601 的账号
EOF
    [[ "${1:-}" == "" ]] && exit 1 || exit 0
    ;;
esac

ACCOUNT="$1"
PROFILE=".playwright-profile-${ACCOUNT}"

# 账号名不能和 config.json 里已有的重复
if node -e "const c=require('./config.json'); process.exit((c.accounts||[]).some(a=>a.name===process.argv[1])?0:1)" "$ACCOUNT"; then
  echo "❌ config.json 里已存在账号 '$ACCOUNT'，请换个名字，或先手动删除旧条目。"
  exit 1
fi

echo "═══ 第 1/3 步：打开登录页 ═══"
echo ">>> 即将用新 profile ($PROFILE) 打开登录页。"
echo ">>> 请在浏览器里用 $ACCOUNT 本人账号登录统一身份认证，"
echo ">>> 看到场地预约页面后【直接关闭浏览器窗口】（不要 Ctrl+C）。"
echo ""

PROFILE_DIR="$PROFILE" node -e "
const path = require('path');
const { chromium } = require('playwright');
const c = require('./config.json');
const url = c.url || 'https://cgyy.buaa.edu.cn/venue/venue-reservation/38';
(async () => {
  const opts = {
    headless: false, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    viewport: null, args: ['--start-maximized'],
  };
  if (c.browserExecutablePath) opts.executablePath = c.browserExecutablePath;
  const ctx = await chromium.launchPersistentContext(path.resolve(process.env.PROFILE_DIR), opts);
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto(url);
  await ctx.waitForEvent('close', { timeout: 0 });
})();
"

echo ""
echo "═══ 第 2/3 步：填写账号信息 ═══"
read -r -p "手机号: " PHONE
read -r -p "同伴姓名（companions）: " COMPANION

# 用 node 安全地把新账号写进 config.json（保留原有格式/字段）
PROFILE_DIR="$PROFILE" ACC_NAME="$ACCOUNT" ACC_PHONE="$PHONE" ACC_COMP="$COMPANION" node -e "
const fs = require('fs');
const c = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
c.accounts = c.accounts || [];
c.accounts.push({
  name: process.env.ACC_NAME,
  enabled: true,
  userDataDir: process.env.PROFILE_DIR,
  concurrency: 1,
  phone: process.env.ACC_PHONE,
  companions: process.env.ACC_COMP ? [process.env.ACC_COMP] : [],
  slotPreferences: [],
});
fs.writeFileSync('./config.json', JSON.stringify(c, null, 2) + '\n');
console.log('✅ 已写入 config.json：' + process.env.ACC_NAME + ' (' + process.env.ACC_PHONE + ' / ' + (process.env.ACC_COMP||'无同伴') + ')');
"

echo ""
echo "═══ 第 3/3 步：保存登录态 ═══"
echo ">>> 即将运行 save-auth，它会再开一个浏览器窗口读取登录态。"
echo ">>> 这次【不用重新登录】，直接关闭那个窗口即可。"
echo ""
bash test-submit.sh --save-auth --account "$ACCOUNT"

echo ""
echo "🎉 账号 $ACCOUNT 配置完成。登录态：${PROFILE}-auth.json"
echo "   以后可用 bash check-login.sh $ACCOUNT 检查登录是否有效。"
