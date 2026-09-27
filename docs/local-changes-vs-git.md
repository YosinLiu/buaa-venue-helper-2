# 增强版与历史 Git 基线差异

[返回 README](../README.md) · [双账号运行手册](dual-account-runbook.md)

本文初始记录于 2026-09-23，更新于 2026-09-27。比较基线固定为历史提交 `78085b9`（`add account helpers + debug tools, expand README into full manual`），描述此后纳入仓库的生产增强。它不是“当前未提交修改”清单；提交或推送后仍使用这个历史基线比较：

```bash
git status --short
git diff --stat 78085b9
git diff 78085b9 -- README.md docs/ test-submit.js run-daily.sh run-daily.local.example.sh schedule-once.sh dump-availability.mjs config.example.json package.json tests/ .gitignore
```

`git status` 查看尚未提交的工作树变化；`git diff 78085b9` 同时包含该历史提交之后已经提交和当前尚未提交的受跟踪文件变化，新文件需纳入 Git 后才会显示。

相对基线的主要变更：

| 状态 | 文件 | 作用 |
| --- | --- | --- |
| 修改 | `.gitignore` | 忽略 `.venv`、auth 备份、日志目录和 runtime 备份 |
| 修改 | `README.md` | 增加整点模式、双账号、timing-test 和部署说明 |
| 修改 | `config.example.json` | 改为无真实凭据的双账号示例 |
| 修改 | `dump-availability.mjs` | 支持命令行指定场馆并解析当前 day/info 数据结构 |
| 修改 | `schedule-once.sh` | 改为整点串行、单次提交和补抢模板 |
| 修改 | `schedule-once-2.sh` | 旧定时模板的默认账号改为匿名示例 |
| 修改 | `package.json` | 增加 `npm test` 离线回归检查入口 |
| 新增 | `tests/retry-selection.cjs` | 检查严格连续两小时、同一时段去重及提交参数互斥 |
| 修改 | `test-submit.js` | 增加校时、门槛、错峰、双场馆、补抢选择和详细日志 |
| 新增 | `run-daily.sh` / `run-daily.local.example.sh` | launchd 双账号入口与私有本机覆盖配置模板 |
| 新增 | `requirements-macos.txt` | macOS OCR 依赖记录 |
| 新增 | `docs/*.md` | 双账号手册和 Git 差异说明 |

`config.json`、账号 auth/profile、日志与 runtime 备份属于私有运行数据，由 `.gitignore` 默认忽略，不应纳入 Git。

## 1. 新增文件

### `run-daily.sh`

每日生产调度入口，由 launchd 每天 06:50 执行。Git 基线没有该文件。

新增能力：

- 同时启动两个账号的独立 `test-submit.js` 进程。
- 每账号独立场地、时段、日志和登录态。
- 第二账号整体错峰 300ms。
- 账号资料不完整或 auth 缺失时自动跳过。
- 分账号配置首轮场地与时段，两个账号共用晚间 18:00–22:00 补抢窗口并要求同场连续两小时；统一配置 5900ms 门槛和 server safety delay。
- PID 防重入、退出清理和 07:00:15 后拒绝迟到执行。
- 默认使用匿名账号 `account1/account2`；真实账号、Node.js 路径及可选的日常参数从被忽略的 `run-daily.local.sh` 加载，示例见 `run-daily.local.example.sh`。

### `requirements-macos.txt`

本地 macOS OCR 环境依赖记录。

### `docs/dual-account-runbook.md` 与 `docs/local-changes-vs-git.md`

生产操作手册和 Git 差异说明。Git 基线没有 `docs/` 目录。

## 2. `test-submit.js` 的主要增强

### 2.1 整点串行模式

新增：

- `--start-at`
- `--start-offset-ms`
- `--server-safety-delay-ms`
- `--min-flow-duration-ms`
- `--timing-test`

流程固定为：

```text
提前启动进程和 OCR worker
→ 本地预计算场地/timeId/同行人 ID
→ 服务器时钟预校准
→ 到账号自己的流程起点后获取验证码
→ OCR 与 captcha/check
→ 等到最短流程门槛
→ 单次提交
```

`--timing-test` 会完成到提交前的全部步骤，但绝不发送 `/api/reservation/order/submit`，也不会进入失败后的补抢分支。

### 2.2 服务器时钟预校准

在目标时间前约一分钟对预约页做多次 HEAD 取样，估算：

- 服务器与本机时间偏差中值
- 保守偏差下界
- 请求 RTT

首轮和补抢复用同一次校准，07:00 后不再为校时额外请求服务器。如果所有样本失败，降级到本机系统时间并在日志中记录“本机 NTP 回退”。脚本本身不请求 NTP 服务器；使用该回退的前提是 macOS 已开启网络时间同步。

### 2.3 5900ms 提交门槛

Git 基线没有“流程开始到提交”的硬门槛。增强版用 monotonic clock 保证门槛不受系统时间跳变影响。

历史 6000ms 样本统计：

| 指标 | 数值 |
| --- | ---: |
| 样本数 | 10 |
| 提交门槛平均 | 6001.3ms |
| 响应总耗时平均 | 6404.5ms |
| 响应总耗时中位数 | 6348ms |
| 网络附加耗时最短 | 119ms |
| 网络附加耗时最长 | 1136ms |

当前生产值设为 5900ms。按历史最快网络耗时，预计最快响应约为 6019ms。5800ms 或 5500ms 可能让结果早于 6 秒，因此没有采用。

### 2.4 双账号错峰

两个进程使用相同的 `--start-at`，第二个进程额外传：

```text
--start-offset-ms 300
```

该偏移会同时影响：

- 首轮验证码开始
- OCR/check
- 订单提交
- 补抢验证码时间门
- 补抢轮询时间门
- 补抢窗口截止时间

实际 timing-test 中两个流程起点通常相差约 240–466ms，配置目标为 300ms，实际差值还受各自校时和调度影响。

### 2.5 本地 buddyId 预缓存

整点模式要求 `config.json` 预先配置 `buddyIds`，避免开始后调用 `/api/buddies` 增加网络请求和不确定性。如果同行人仅有姓名而没有本地 buddyId，脚本会拒绝整点模式。

### 2.6 动态场馆与预测 ID

本地版增强了 `venueSiteId` 处理：

- 主馆 1–12 号映射到 venue 38。
- 副馆 17–24 号映射到 venue 39。
- Referer 会随场馆变化。
- 预测模式根据日期、场馆、场地和时段直接计算 `spaceId/timeId`。

### 2.7 补抢选择策略

新增或完善：

- `--retry-any-court`
- `--retry-require-all`
- `--retry-fallback-single`
- `--retry-prefer-consecutive-two`
- `--retry-require-consecutive-two`
- `--retry-submit-attempts`
- `--submit-attempts`

当前持续生效的策略（最近沿用示例：`2026-09-27 07:00` 抢 `2026-09-29`）为：账号 1 首轮选择主馆 1 号场 `20:00–22:00`，账号 2 首轮选择主馆 2 号场 `18:00–20:00`。每日脚本按运行日期加两天计算预约日期，这些场地和时段会持续生效，直到再次修改。

本地生产配置在首轮失败后：

1. 首轮基准 +90s 获取补抢验证码。
2. +120s 开始轮询 `day/info`。
3. 两个账号共用 `RETRY_TIMES="18:00-19:00,19:00-20:00,20:00-21:00,21:00-22:00"`，以 `--retry-times "$RETRY_TIMES"` 搜索主馆任意 1–12 号场。
4. 使用 `--retry-any-court --retry-max-slots 2 --retry-require-consecutive-two`，只选择同场连续两小时（`18:00–20:00`、`19:00–21:00` 或 `20:00–22:00`）。没有合适组合时继续轮询，直到达到退出条件；不订满四小时，不降级为一小时。正式配置不使用 `--retry-require-all`、`--retry-prefer-consecutive-two` 或 `--retry-fallback-single`。
5. 首轮和补抢订单请求各限制为一次；补抢窗口从各账号首轮基准起算，最迟在 +200s 截止，并非轮询开始后再持续 200s。全体目标时段均已售出时可提前退出。

`--retry-require-consecutive-two` 是本次新增的严格约束：没有同场连续两个一小时时段时不生成补抢订单。旧参数 `--retry-prefer-consecutive-two` 仍按原有逻辑优先选连续两小时，没有合适组合时可降级为一小时。

通用补抢选择函数 `selectBestRetryItems` 现在按时间段（缺失时按 timeId）去重，避免收集多个场地后把同一个小时的不同场地同时选进订单；同场连续时段仍优先。严格两小时分支保持同场相邻两个一小时时段约束。

### 2.8 更完整的 timing 日志

日志新增：

- 目标流程起点（精确到毫秒）
- 服务器校准结果
- 实际流程开始时间
- CAPTCHA GET/OCR/CHECK 耗时
- 等待提交门槛的剩余时间
- 发单前总流程耗时
- 收到响应时总流程耗时

这些日志用于重新评估门槛和错峰，不应只看某一天的成功或失败。

## 3. OCR 并发方式

Git 基线主要面向单账号。本地生产版由两个独立 Node 进程分别启动一个常驻 DDDDOCR worker：

- 两个验证码可并行识别。
- 不会因为账号 1 OCR 变慢而阻塞账号 2。
- 实测每个 worker 约 200 MiB RSS，两个合计约 403 MiB。
- 实测 OCR 通常约 200–310ms。

共享一个 worker 能节省约 200 MiB，但会引入排队，因此当前未采用。

## 4. 其他修改

### 离线回归检查

`npm test` 执行 `tests/retry-selection.cjs`，不联网、不读取账号、不下单。检查覆盖严格连续两小时、通用选择的同一时段去重，以及 `--timing-test` 与 `--execute` 的互斥保护。

### `schedule-once.sh`

更新为整点串行流程，增加 server calibration、最短流程门槛、补抢策略和单次提交限制。账号、完整开始时间、预约日期分别通过环境变量 `ACCOUNT`、`START_AT`、`TARGET_DATE` 提供；过期时间会被拒绝。该单次模板仍保留旧的同场完整目标时段优先、可降级一小时策略；每日任务使用严格连续两小时策略。

### `dump-availability.mjs`

支持不同场馆或账号配置的可用性查询，避免固定主馆参数。

### `.gitignore`

增加 `.venv/`、`/logs`（覆盖目录和符号链接）、`backups/`、`run-daily.local.sh` 和 `*-auth.json*` 等忽略项。`*-auth.json*` 的星号用于覆盖重新登录前产生的备份文件，避免旧 token 被误提交。

### `README.md`

增加整点模式、双账号、timing-test、launchd 部署和增强版说明。示例账号及个人路径匿名化，私有参数放入本机覆盖配置。

## 5. 本地生产部署与 Git 工作树的区别

源码目录为 Git checkout 所在位置，可用 `git rev-parse --show-toplevel` 查看。

launchd 实际运行目录：

```text
~/Library/Application Support/buaa-venue-helper-2-runtime/
```

Git 只管理源码；正式任务读取 runtime 副本。因此：

1. 在源码目录修改。
2. 运行语法检查和 timing-test。
3. 备份 runtime 当前版本。
4. 同步代码、文档、私有 `config.json`、`run-daily.local.sh` 和必要的账号 auth/profile。
5. 在 runtime 目录再次运行语法检查、`npm test` 和 `--check`，必要时分别验证登录。

如果只改 Git 工作树而未同步 runtime，第二天 launchd 仍会运行旧配置。

## 6. 不应提交到 Git 的文件

```text
config.json
run-daily.local.sh
.playwright-profile-*/
.playwright-profile-*-auth.json*
logs/
*.log
*.pid
backups/
```

账号密码不应写进任何脚本。脚本仅持久化登录后的 Cookie/token，且 auth/config 文件权限应为 `600`。
