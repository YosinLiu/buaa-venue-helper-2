# 双账号抢场运行手册

[返回 README](../README.md) · [查看增强版与历史 Git 基线差异](local-changes-vs-git.md)

本文说明如何在当前增强版中配置两个独立账号、设置每日场地和时间、进行无提交测试，并部署到 macOS launchd 使用的正式运行目录。

> 只在本人账号及授权范围内使用，并遵守场馆预约规则。不要把 `config.json`、Playwright profile、`*-auth.json` 或密码提交到 Git。

## 每晚修改配置的最短清单

只调整第二天要抢的场地和时段时，按以下顺序操作：

1. 编辑源码目录私有文件 `run-daily.local.sh` 中的 `PRIMARY_COURT`、`PRIMARY_TIMES`、`SECONDARY_COURT` 和 `SECONDARY_TIMES`；两个账号的补抢共同使用 `RETRY_TIMES`，当前为 `18:00–22:00`。
2. 把同样的首轮目标写入 `config.json` 对应账号的 `slotPreferences`，并同步各自的 `retrySlotPreferences` 搜索窗口。
3. 执行 `bash run-daily.sh --check`，确认账号、场地、时段和自动计算的预约日期。
4. 执行双账号 `--timing-test`，确认首轮场地 `spaceId/timeId`、300ms 错峰和 5900ms 门槛（此演练不进入失败后的补抢分支）；不要加 `--execute`。
5. 备份并同步到 `~/Library/Application Support/buaa-venue-helper-2-runtime/`。
6. 进入 runtime 再执行一次 `bash run-daily.sh --check`。

如果只是重新登录，不需要修改时间参数；刷新对应 `*-auth.json` 后同步 auth 文件和 profile 即可。

## 1. 运行结构

生产任务的调用关系：

```text
launchd（每天 06:50）
  └─ run-daily.sh
      ├─ test-submit.js --account account1
      │   └─ 独立 DDDDOCR worker
      └─ test-submit.js --account account2 --start-offset-ms 300
          └─ 独立 DDDDOCR worker
```

两个账号之间隔离：

- Playwright profile
- Cookie/token auth 文件
- 预约手机号
- 同行人及 buddyId
- 首轮目标场地与时段
- 日志文件

## 2. 新增和登录第二账号

### 2.1 创建账号配置

推荐使用辅助脚本：

```bash
bash add-account.sh account2
```

该脚本会建立 profile、收集手机号/同行人并保存 auth，但不会自动解析同行人的内部 `buddyId`。账号创建后，仍需运行 `dump-buddies.mjs` 并写入 `buddyIds`；在此之前建议将 `enabled` 保持为 `false`。

当前版本的 `add-account.sh` 初始写入 `enabled: true`，但 `run-daily.sh` 还会检查 `buddyIds` 和 auth 文件；资料不完整时会跳过该账号。为避免误解，仍建议创建后立即手工改为 `enabled: false`，完成全部验证后再启用。

也可以手工在 `config.json` 的 `accounts` 数组中增加：

```json
{
  "name": "account2",
  "enabled": false,
  "userDataDir": ".playwright-profile-account2",
  "concurrency": 1,
  "phone": "YOUR_PHONE",
  "companions": ["YOUR_COMPANION"],
  "buddyIds": [12345],
  "slotPreferences": [
    {
      "court": "2号",
      "times": ["18:00-19:00", "19:00-20:00"]
    }
  ],
  "retrySlotPreferences": [
    {
      "court": "",
      "times": ["18:00-19:00", "19:00-20:00", "20:00-21:00", "21:00-22:00"]
    }
  ]
}
```

建议账号信息未完整时保持 `enabled: false`，避免 launchd 误用。

### 2.2 建立独立登录态

```bash
bash test-submit.sh --save-auth --account account2
```

流程：

1. 脚本使用 `.playwright-profile-account2` 打开北航预约站。
2. 在弹出的窗口中登录账号。
3. 进入预约页面后关闭整个窗口。
4. 脚本重新以 headless 模式读取 profile，并生成 `.playwright-profile-account2-auth.json`。

重新登录已有账号时，应先在页面中退出，再重新登录；否则只会重新导出旧 token。

### 2.3 验证登录和同行人

```bash
node dump-buddies.mjs account1
node dump-buddies.mjs account2
```

检查：

- `HTTP 200`
- JSON `code` 为 `200`
- `config.json` 中的同行人显示“匹配到”

账号自己的手机号可以从 `/api/venue/students/<userId>` 只读接口核对，但不要在日志或 Git 中输出完整号码。

## 3. 设置两个账号的场地和时间

首次部署先建立私有覆盖文件：

```bash
cp run-daily.local.example.sh run-daily.local.sh
chmod 600 run-daily.local.sh
```

`run-daily.sh` 先加载公开默认值，再读取同目录的 `run-daily.local.sh`。在私有文件中设置真实账号名及需要覆盖的参数；下面用匿名账号举例：

```bash
PRIMARY_ACCOUNT="account1"
SECONDARY_ACCOUNT="account2"

PRIMARY_START_OFFSET_MS=0
SECONDARY_START_OFFSET_MS=300

PRIMARY_COURT="1号"
PRIMARY_TIMES="20:00-21:00,21:00-22:00"

SECONDARY_COURT="2号"
SECONDARY_TIMES="18:00-19:00,19:00-20:00"

RETRY_TIMES="18:00-19:00,19:00-20:00,20:00-21:00,21:00-22:00"

MIN_FLOW_DURATION_MS=5900
SERVER_SAFETY_DELAY_MS=0
```

如果 Node.js 由 nvm 管理，或 launchd 找不到 Node.js，在私有文件中设置 `NODE_BIN_DIR="/绝对路径/到/node/bin"`；可在交互终端用 `dirname "$(command -v node)"` 查看。脚本会把该目录（如有）和常见 Homebrew 路径加入 `PATH`，保留原有路径。

不要把真实账号名、个人路径或凭据改进公开模板；`run-daily.local.sh` 不提交到 Git。

同时把相同的首轮偏好写入 `config.json` 的各账号 `slotPreferences`，并将两个账号的 `retrySlotPreferences` 搜索时段都设置为 `18:00–22:00`，使手工运行和定时运行的偏好保持一致。手工补抢也要传入下述严格连续两小时参数。

当前持续生效的策略（最近沿用示例：`2026-09-27 07:00` 抢 `2026-09-29`）为：账号 1 首轮选择主馆 1 号场 `20:00–22:00`，账号 2 首轮选择主馆 2 号场 `18:00–20:00`。脚本每天按运行日期加两天计算预约日期，以上场地和时段会持续生效，直到再次修改。

正式脚本让两个账号共用 `RETRY_TIMES`，传入 `--retry-times "$RETRY_TIMES" --retry-any-court --retry-max-slots 2 --retry-require-consecutive-two`。第二轮可在主馆 1–12 号场中换场，并从 `18:00–22:00` 中选择同场连续两小时：`18:00–20:00`、`19:00–21:00` 或 `20:00–22:00`。没有合适组合时继续轮询，直到达到退出条件；每个账号只订两小时，不订满四小时，也不降级为一小时。此配置不使用 `--retry-require-all`、`--retry-prefer-consecutive-two` 或 `--retry-fallback-single`。

新参数 `--retry-require-consecutive-two` 是严格要求同场连续两小时。旧参数 `--retry-prefer-consecutive-two` 的通用行为保持不变，它会在没有连续两小时的情况下降级为一个小时，不用于保证当前补抢的完整两小时要求。

## 4. 5.9 秒门槛的含义

当前时间线：

```text
账号1: 07:00:00.000 开始验证码流程 → 约 07:00:05.900 发单
账号2: 07:00:00.300 开始验证码流程 → 约 07:00:06.200 发单
```

以上是名义时间。实际流程起点还会受到服务器 Date 头秒级精度、网络 RTT 和保守下界校准影响。历史 timing-test 中两个流程实际相差约 `240–466ms`，因此“300ms”应理解为配置错峰目标，而不是每次都精确到单毫秒。

历史 6000ms 门槛样本：

| 指标 | 结果 |
| --- | ---: |
| 完整 6000ms 样本数 | 10 |
| 提交门槛平均 | 6001.3ms |
| 响应总耗时平均 | 6404.5ms |
| 响应总耗时中位数 | 6348ms |
| 网络响应附加耗时范围 | 119–1136ms |
| 最近 7 次响应平均 | 6319.3ms |

选择 5900ms 的理由：历史最快响应附加耗时为 119ms，预计最快结果约为 6019ms。若设置为 5800ms，最快结果可能约 5919ms；5500ms 风险更高。

注意：这只是历史经验值，不能严格保证响应一定晚于 6 秒。如果这是不可违反的硬条件，应使用 `MIN_FLOW_DURATION_MS=6000` 或更高。若服务器、网络或规则发生变化，应重新统计日志后调整。

重新评估时至少统计：

- `已到提交门槛：流程耗时`
- `订单响应时总流程耗时`
- 两者差值，即网络/服务器附加耗时
- 成功与失败结果，避免只根据单次成功调整参数

## 5. 双账号启动方式

### 5.1 手工检查配置

```bash
bash run-daily.sh --check
```

它会显示：

- 两个账号
- 各自首轮场地和时段
- 300ms 错峰
- 5900ms 门槛
- 自动计算的预约日期
- 补抢范围

该命令不会预约，也不验证登录或账号资料是否完整。日期按运行当天计算；07:00 后检查仍显示当天的计划。

### 5.2 手工启动正式任务

通常不需要手工运行，launchd 会在 06:50 启动。如果需要手工运行：

```bash
mkdir -p logs
nohup bash run-daily.sh > logs/manual-daily.out.log 2>&1 &
```

脚本若在当天 `07:00:15` 后才启动，会拒绝迟到执行。手工正式运行仍会提交订单，应避免与 launchd 重复启动。

每个账号写独立日志：

```text
logs/formal-YYYY-MM-DD-account1.log
logs/formal-YYYY-MM-DD-account2.log
```

### 5.3 launchd

LaunchAgent 命名示例（已有部署请使用实际安装的 Label）：

```text
~/Library/LaunchAgents/com.example.buaa-venue.daily.plist
```

它每天 06:50 调用：

```text
~/Library/Application Support/buaa-venue-helper-2-runtime/run-daily.sh
```

检查状态：

```bash
launchctl print gui/$(id -u)/com.example.buaa-venue.daily
```

最小 plist 模板如下。plist 不展开 `$HOME`，必须换成真实绝对路径：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.example.buaa-venue.daily</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/YOUR_USER/Library/Application Support/buaa-venue-helper-2-runtime/run-daily.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOUR_USER/Library/Application Support/buaa-venue-helper-2-runtime</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>6</integer>
    <key>Minute</key><integer>50</integer>
  </dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
```

加载或更新 LaunchAgent：

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.example.buaa-venue.daily.plist" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.example.buaa-venue.daily.plist"
```

不要用 `launchctl kickstart` 测试正式脚本，因为 `run-daily.sh` 包含 `--execute`。使用 `--check` 和 `--timing-test` 验证。

`run-daily.sh` 使用 macOS 的 `date -v+2d` 自动预约后天。每天修改完配置后，应确认 `bash run-daily.sh --check` 打印的预约日期正确。

## 6. 无提交验证

修改场地、时间、账号或 timing 参数后，先做基础检查：

```bash
node --check test-submit.js
bash -n run-daily.sh
bash run-daily.sh --check
npm test
```

再运行两个账号的 `--timing-test`。它验证首轮验证码与时间门，不会生成订单，也不进入补抢选择和提交分支；`npm test` 使用离线样本验证补抢的严格两小时约束、同一时段不重复选择多个场地，以及提交模式参数互斥，不联网、不读取账号、不下单。演练示例：

```bash
START_AT="$(date -v+15S '+%Y-%m-%d %H:%M:%S')"
TARGET_DATE="$(date -v+2d '+%Y-%m-%d')"
RETRY_TIMES="18:00-19:00,19:00-20:00,20:00-21:00,21:00-22:00"

bash test-submit.sh \
  --start-at "$START_AT" --start-offset-ms 0 \
  --server-safety-delay-ms 0 --min-flow-duration-ms 5900 \
  --account account1 --date "$TARGET_DATE" \
  --venue-site-id 38 --court '1号' --times '20:00-21:00,21:00-22:00' \
  --retry-times "$RETRY_TIMES" --retry-any-court \
  --retry-max-slots 2 --retry-require-consecutive-two \
  --with-captcha --day-info-mode predict --timing-test &

bash test-submit.sh \
  --start-at "$START_AT" --start-offset-ms 300 \
  --server-safety-delay-ms 0 --min-flow-duration-ms 5900 \
  --account account2 --date "$TARGET_DATE" \
  --venue-site-id 38 --court '2号' --times '18:00-19:00,19:00-20:00' \
  --retry-times "$RETRY_TIMES" --retry-any-court \
  --retry-max-slots 2 --retry-require-consecutive-two \
  --with-captcha --day-info-mode predict --timing-test &

wait
```

成功日志应包含：

```text
预约流程开始
OCR 完成
captcha/check 完成
已到提交门槛：流程耗时约 5900ms（验证码较慢时可更长）
TIMING-TEST ... 未发送订单请求
```

凌晨或维护时段验证码接口可能返回 502/504。此时可以在 `--timing-test` 中用假 `--captcha-verification` 验证场地 ID 和时间门，但这不能证明真实验证码链路或登录有效；假值不得用于 `--execute`。

## 7. 同步到正式运行目录

launchd 不运行桌面源码，而是运行 runtime 副本。修改并测试后同步：

下列命令从源码目录执行；示例中的账号/profile 名要替换为本机配置。先备份 runtime 已有文件：

```bash
RUNTIME="$HOME/Library/Application Support/buaa-venue-helper-2-runtime"
BACKUP="$RUNTIME/backups/before-sync-$(date '+%Y%m%d-%H%M%S')"
mkdir -p "$BACKUP"
rsync -a --exclude '/backups/' --exclude '/logs' --exclude '*.pid' \
  "$RUNTIME/" "$BACKUP/"

rsync -a \
  test-submit.js test-submit.sh run-daily.sh run-daily.local.sh \
  README.md config.example.json config.json requirements-macos.txt package.json \
  "$RUNTIME/"
rsync -a docs/ "$RUNTIME/docs/"
rsync -a tests/ "$RUNTIME/tests/"

# 重新登录或首次部署时，分别同步两个账号的 profile 和 auth
for ACCOUNT in account1 account2; do
  rsync -a ".playwright-profile-${ACCOUNT}/" \
    "$RUNTIME/.playwright-profile-${ACCOUNT}/"
  rsync -a ".playwright-profile-${ACCOUNT}-auth.json" "$RUNTIME/"
done

chmod 700 "$RUNTIME/run-daily.sh"
chmod 600 "$RUNTIME/run-daily.local.sh" "$RUNTIME/config.json"
```

auth 文件也应单独设为 `600`，例如 `chmod 600 "$RUNTIME/.playwright-profile-account1-auth.json"`。首次部署还须将其余源码、依赖和 OCR worker 安装到 runtime，并确保 `config.json` 的 `pythonBin` 在 runtime 中可用；上述命令用于已有部署的更新，不是完整安装器。不要在任务运行期间覆盖 profile 或执行回滚。

同步后再次运行：

```bash
cd "$RUNTIME"
bash run-daily.sh --check
npm test
node dump-buddies.mjs account1
node dump-buddies.mjs account2
```

回滚时，将对应 `backups/before-*` 目录中的代码、文档、私有 `config.json`、`run-daily.local.sh` 和必要的 auth/profile 一并恢复，然后再次运行语法检查和 `--check`。备份含私有信息，不要提交或分享。Git 更新和推送不会自动同步 runtime。

## 8. 常见问题

### 登录页没有出现，直接进入预约页

说明旧 token 仍有效。若要真正续期，应在 profile 窗口中退出后重新登录，再关闭窗口让 `--save-auth` 导出新状态。

### 第二账号被跳过

`run-daily.sh` 会检查：

- 账号已启用
- 手机号非空
- `buddyIds` 非空
- auth 文件存在

任一条件不满足就跳过，并写入该账号日志。

### 两个账号是否共用 OCR

当前不是。每个 `test-submit.js` 进程各启动一个 DDDDOCR worker，可并行识别。实测两份模型合计约 `403 MiB RSS`，OCR 耗时约 `200–310ms`，资源可接受且不会互相排队。

### 验证码接口凌晨返回 502/504

这可能涉及后端维护、网关或网络问题，单凭状态码不能确定原因，也不能证明登录已失效。正式 07:00 前应再确认登录态与网络环境。

### 怎么确认没有发送订单

必须看到：

```text
TIMING-TEST: 已完整走到提交前……未发送订单请求。
```

不要同时使用 `--timing-test` 和 `--execute`，脚本会拒绝执行。
