# BUAA Venue Helper 2

北航场馆预约辅助脚本。支持浏览器页面预约流程、验证码识别（DDDDOCR / Gemini / 超级鹰），以及直接调用预约接口的定时抢场脚本，含多账号管理与「捡漏」重试。

> ⚠️ 仅用于本人账号及授权范围内的场地预约，请确认自动化行为符合场馆系统规则。

## 当前增强版

本版本在历史 Git 基线 `78085b9` 上增加了双账号定时抢场、服务器时钟预校准、约 6 秒的安全提交时间门、补抢策略和 launchd 自动运行。最常用的两个文档是：

- [双账号运行手册](docs/dual-account-runbook.md)：如何登录两个账号、设置每日场地和时间、测试、启动及查看日志。
- [增强版与历史 Git 基线差异](docs/local-changes-vs-git.md)：相对固定历史基线 `78085b9` 新增了什么，以及为什么采用 5900ms 门槛和 300ms 错峰。

本文的 macOS 部署方案由 launchd 每天 `06:50` 调用运行目录中的 `run-daily.sh`。**只修改源码或推送 Git 不会自动影响正式任务**，修改后必须同步到：

```text
~/Library/Application Support/buaa-venue-helper-2-runtime/
```

首次部署时，先复制并编辑本机私有配置：

```bash
cp run-daily.local.example.sh run-daily.local.sh
chmod 600 run-daily.local.sh
```

在 `run-daily.local.sh` 中设置两个真实账号名；若 launchd 无法找到 Node.js，再设置 `NODE_BIN_DIR`。该文件已被 Git 忽略，也可覆盖每日场地、时段、错峰和门槛。详见运行手册。

建议每次修改后执行：

```bash
bash run-daily.sh --check
node --check test-submit.js
bash -n run-daily.sh
npm test
```

---

## 1. 环境安装

需要 **Node.js 18+** 和 **Python 3.9+**。

```bash
# Node 依赖 + Playwright 浏览器
npm install
npx playwright install chromium

# Python 依赖（验证码识别）
pip install -r requirements.txt
pip install --no-deps ddddocr==1.6.1
```

- macOS / Apple Silicon CPU 环境可使用 `pip install -r requirements-macos.txt` 替代 `requirements.txt`，再单独安装上面的 `ddddocr==1.6.1`。建议在项目 `.venv` 中安装，并将 `config.json` 的 `pythonBin` 设为 `.venv/bin/python`。
- 若系统已装 Chrome/Chromium，可在 `config.json` 里用 `browserExecutablePath` 指定，省去 `playwright install`。

---

## 2. 配置

```bash
cp config.example.json config.json
```

模板的两个账号默认 `enabled: false`。填写真实手机号、同行人及 `buddyIds`，分别建立并验证登录态后，再将需要每日执行的账号设为 `enabled: true`。`12345` / `67890` 仅是示例 ID，必须替换。

编辑 `config.json`，关键字段：

| 字段 | 说明 |
| --- | --- |
| `url` | 场地预约页面地址 |
| `dateText` / `releaseTime` / `refreshDateTexts` | 预约日期文案与放号时间（浏览器流程用） |
| `accounts[]` | 多账号数组，每个账号含 `name`（简称，供 `--account` 使用）、`userDataDir`（浏览器 profile 目录）、`phone`、`companions`（同行人）、`slotPreferences`（场地/时间偏好） |
| `slotPreferences` | 默认场地与时间段 |
| `captchaSolver` | 验证码方案：`ddddocr`（默认，本地）/ `gemini` / 超级鹰 |
| `pythonBin` | Python 可执行文件，默认 `python3` |

> 🔒 `config.json`、Playwright profile 目录、`*-auth.json` 登录态缓存**默认不提交到 Git**（见 [第 7 节](#7-隐私与-gitignore)），避免泄露手机号、同行人、Cookie 或 token。

---

## 3. 账号管理

### 3.1 新增账号（一条命令）

```bash
bash add-account.sh <账号名>      # 例如 bash add-account.sh 2601
```

脚本会自动完成三步：

1. 用新 profile 打开登录页 → 你在浏览器里登录，**看到场地预约页面后直接关闭窗口**（不要 Ctrl+C）；
2. 提示输入手机号 / 同伴姓名，写入 `config.json`；
3. 运行 `save-auth` 保存登录态到 `.playwright-profile-<账号名>-auth.json`。

`add-account.sh` 不知道目标同行人的内部 `buddyId`，因此新增账号后还不能直接用于整点生产任务。必须先运行 `node dump-buddies.mjs <账号名>`，把匹配到的 `id` 写入该账号的 `buddyIds`，再将账号设为启用。

### 3.2 检查登录态

```bash
bash check-login.sh <账号名>      # 检查指定账号
bash check-login.sh               # 不带参数：列出所有账号及其 profile
```

用该账号 profile 打开预约页面：

- 直接看到场地预约页面 → token 有效 ✅
- 跳转到统一身份认证登录页 → token 失效，需重新登录 ❌

检查完直接关闭浏览器窗口即可。

### 3.3 Token 过期重新登录

脚本报 `code=408: Token已失效，请重新登录` 时：

```bash
# 1. 打开该账号 profile 页面（它会加载已有登录态）
bash check-login.sh <账号名>
#    若跳到登录页，就在这个窗口里重新登录，看到预约页面后关闭窗口

# 2. 重新保存登录态
bash test-submit.sh --save-auth --account <账号名>

# 3. 验证到提交前（不会真正提交）
TARGET_DATE="$(date -v+2d '+%Y-%m-%d')"
bash test-submit.sh --account <账号名> --date "$TARGET_DATE" \
  --court '1号' --times '20:00-21:00,21:00-22:00' \
  --with-captcha --day-info-mode predict --timing-test
```

还应运行 `node dump-buddies.mjs <账号名>` 确认受保护接口返回 `HTTP 200`、`code=200`。演练应完成 `captcha/check` 并显示 `TIMING-TEST ... 未发送订单请求`。仅有 `DRY-RUN: 未提交` 不能证明登录有效，尤其 `predict-no-captcha` 的普通 dry-run 会在验证码阶段前退出。

### 3.4 两个账号的隔离原则

两个账号必须使用不同的浏览器 profile 和 auth 文件，不能复制或共用 Cookie：

```text
.playwright-profile-account1/
.playwright-profile-account1-auth.json
.playwright-profile-account2/
.playwright-profile-account2-auth.json
```

`config.json` 中每个账号至少要配置：

- 唯一的 `name` 和 `userDataDir`
- 预约手机号 `phone`
- 同行人姓名 `companions`
- 与同行人对应的 `buddyIds`
- 首轮 `slotPreferences`
- 补抢 `retrySlotPreferences`

正式启用前必须分别验证：

```bash
node dump-buddies.mjs account1
node dump-buddies.mjs account2
```

两个命令都应返回 `HTTP 200`、`code=200`，且配置的同行人显示“匹配到”。完整流程见 [双账号运行手册](docs/dual-account-runbook.md)。

---

## 4. 使用

### 4.1 浏览器页面流程（run.sh）

```bash
bash run.sh login   --account account1   # 首次登录并写入本地 profile
bash run.sh reserve --account account1   # 正常预约
bash run.sh inspect --account account1   # 查看页面状态
```

### 4.2 接口直提（test-submit.sh，推荐用于 07:00 抢场）

不加 `--execute` 时不会发送订单请求；普通 **dry-run** 准备并打印调试信息，部分模式还会查询同行人或执行验证码。加 `--timing-test` 可完整演练首轮至提交前；加 `--execute` 才真正提交。

```bash
bash test-submit.sh --at "07:00:00" --account <账号名> --date 2026-04-17 \
  --court '2号' --times '07:00-08:00' \
  --with-captcha --day-info-mode predict-no-captcha --execute
```

**常用参数：**

| 参数 | 说明 |
| --- | --- |
| `--account NAME` | 账号名（必填） |
| `--date YYYY-MM-DD` | 预约日期 |
| `--court NAME` | 场地，如 `6号` |
| `--times A,B` | 时间段，如 `07:00-08:00,19:00-20:00` |
| `--at TIME` | 目标提交时刻，提前启动预热、到点发请求。支持 `HH:MM[:SS]` 或 `YYYY-MM-DD HH:MM[:SS]` |
| `--with-captcha` | 提交前获取点选验证码并用 DDDDOCR 校验 |
| `--day-info-mode MODE` | 抢场策略（见下表） |
| `--retry-on-fail` | 首次失败后进入「捡漏」模式（见 [4.4](#44-捡漏重试--retry-on-fail)） |
| `--execute` | 真正提交；不加则仅 dry-run |
| `--save-auth` | 打开浏览器读取并保存登录态后退出（首次或过期时用） |
| `--headless` | 无头模式读取登录态 |

完整参数见 `bash test-submit.sh --help`。

下表描述传统 `--at` 调度下的五种策略。当前每日任务采用第 4.5 节的 `--start-at` + `predict`，验证码同样在流程开始后获取。

**五种 `--day-info-mode` 策略：**

| 模式 | 说明 |
| --- | --- |
| `predict`（默认） | 提前解验证码 + 规则预测 timeId，到点直接提交（最快） |
| `poll` | 提前解验证码 + 到点轮询 day/info 用真实 ID 提交 |
| `predict-no-captcha` | 规则预测 ID，**到点后才解验证码**（07:00 放号推荐，避免跨天 token 失效） |
| `poll-no-captcha` | 到点后先轮询 day/info，再串行解验证码并提交 |
| `predict-late-check` | 提前 ~30s 完成 GET+OCR，到点后 CHECK+提交（兼顾速度与 07:00 token 安全，实验中） |

### 4.3 定时抢场（schedule-once.sh）

`schedule-once.sh` 是单次整点任务模板。通过环境变量提供账号、完整开始时间和预约日期，并检查脚本中的场地、时段与补抢参数。示例日期须换成计划执行日：

```bash
ACCOUNT=account1 START_AT="2026-09-28 07:00:00" TARGET_DATE="2026-09-30" \
  nohup bash schedule-once.sh &

# 日志和 PID 使用 START_AT 中的日期及账号名
tail -f logs/formal-2026-09-28-account1.log
```

该模板默认首轮主馆 1 号场 `20:00–22:00`，补抢仍采用旧策略：先找同场完整目标时段，没有时可降级为一个小时。它与下述每日任务的严格两小时策略不同。已过期的开始时间会被拒绝。

`schedule-once-2.sh` 保留旧的 sleep 定时模板；使用前须修改顶部账号、启动日期和时间，以及命令中的预约日期、场地与时段。其日志为 `schedule-once-2-<账号>.log`，不会自动继承每日双账号配置。

生产环境的每日双账号任务使用 `run-daily.sh`，不是 `schedule-once.sh`。需要修改场地、时段或账号错峰时，在 `run-daily.local.sh` 中覆盖默认值：

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

当前持续生效的策略（最近沿用示例：`2026-09-27 07:00` 抢 `2026-09-29`）为：账号 1 首轮选择主馆 1 号场 `20:00–22:00`，账号 2 首轮选择主馆 2 号场 `18:00–20:00`。脚本每天按运行日期加两天计算预约日期，以上场地和时段会持续生效，直到再次修改。

两个账号的第二轮补抢都搜索 `18:00–22:00`，正式脚本使用 `--retry-times "$RETRY_TIMES" --retry-any-court --retry-max-slots 2 --retry-require-consecutive-two`。可选择主馆 1–12 号场中任意同场连续两小时，即 `18:00–20:00`、`19:00–21:00` 或 `20:00–22:00`；没有合适组合时继续轮询，直到达到退出条件。每个账号只订两小时，不订满四小时，也不降级为一小时。

然后运行：

```bash
bash run-daily.sh --check
```

该命令只显示按运行当天计算的任务配置，不会发起预约；07:00 后检查时仍显示当天的开始时间，并不会自动切换到明天。

### 4.4 捡漏重试（--retry-on-fail）

07:00 首轮没抢到时自动等待「锁单释放」捡漏：首次提交失败（非验证码原因）后，等待到锁单释放时刻开始每隔 3s 轮询 `day/info`，一旦出现空位（`status=1`）立即提交；所有目标时段都售罄（`status=4`）则提前退出。接口返回 `408`（访问频繁）时立即停止轮询和补抢，避免继续放大限流。

```bash
bash test-submit.sh --at "07:00:00" --account <账号名> --date 2026-04-20 \
  --court '8号' --times '07:00-08:00' \
  --with-captcha --day-info-mode predict-no-captcha \
  --retry-on-fail \
  --retry-times '07:00-08:00,08:00-09:00,09:00-10:00' \
  --execute
```

相关参数：`--retry-window-ms`（从首轮基准起算的窗口截止时间，默认 200s，并非开始轮询后再运行 200s）、`--retry-poll-ms`（轮询间隔，默认 3s）、`--retry-times`（捡漏搜索的时段）、`--retry-court`（限定场地）、`--retry-max-slots`（最多选几个时段）。

`--retry-require-consecutive-two` 要求补抢必须选到同场连续两个一小时时段；配合 `--retry-max-slots 2` 可在较宽的搜索窗口内只订完整两小时，没有合适组合时继续等待。旧参数 `--retry-prefer-consecutive-two` 仅表示优先选择同场连续两小时，其原有通用选择行为不变，未找到连续两小时会降级为一个小时，不等同于严格要求两小时。

### 4.5 整点启动与最短流程时长

如果场馆要求预约流程不能过快，可以让进程提前启动，只在本机预热 OCR 并根据已知场地、时段及缓存的同行人 ID 预计算订单参数。等到整点后才开始网络验证码流程，并保证到提交前经过指定时长。

固定执行顺序为：

`提前预热 OCR → 等待开始时间 → 获取验证码 → OCR → 验证码校验 → 等满最短总时长 → 单次提交`

```bash
bash test-submit.sh \
  --start-at "07:00:00" \
  --min-flow-duration-ms 6000 \
  --account account1 --date 2026-09-09 \
  --venue-site-id 38 --court '1号' --times '08:00-09:00' \
  --with-captcha --day-info-mode predict \
  --execute
```

- `--start-at` 是预约流程的开始时间，不是提交时间。
- `--start-offset-ms` 会把某个账号的验证码、提交和补抢时间基准整体后移，适合双账号错峰。
- `--server-safety-delay-ms` 控制服务器校时后的额外启动缓冲；精确双账号调度可设为 `0`。
- `--min-flow-duration-ms` 默认 `6000`，表示从验证码流程开始到发送订单请求至少等待 6 秒。
- 场地及时间必须通过 `--court`、`--times` 提前指定；同行人 ID 从本地私有 `config.json` 的 `buddyIds` 读取。
- 此模式只允许 `--day-info-mode predict`；资料完整时首轮不查询 `day/info` 或 `buddies`。补抢阶段会查询 `day/info`。
- 此模式禁止与旧的 `--at` 混用。需要补抢时可显式加 `--retry-on-fail`；补抢时间以 `--start-at` 为基准计算。
- `--retry-any-court --retry-require-all` 表示补抢时可选择任意场地，但所有目标时段必须在同一个场地同时可订。
- 再加 `--retry-fallback-single` 后，若没有同场连续全部目标时段，会降级为任意场地的一个目标时段。
- `--submit-attempts 1 --retry-submit-attempts 1` 可将首轮与补抢阶段都限制为最多一次订单请求。
- 日志会打印实际流程开始时间、提交门槛耗时和订单响应时的总耗时。
- 先用 `--timing-test` 替代 `--execute` 做演练。演练会按所选模式执行至首轮提交前，并完成验证码校验；不会发送订单请求，也不会进入失败后的补抢分支。两个参数不能同时使用。

```bash
bash test-submit.sh \
  --start-at "20:43:00" --min-flow-duration-ms 6000 --timing-test \
  --account account1 --date 2026-09-09 \
  --venue-site-id 38 --court '2号' --times '08:00-09:00' \
  --with-captcha --day-info-mode predict
```

当前每日双账号策略使用独立进程和独立登录态：账号 1 从目标时刻开始，账号 2 整体错峰 `300ms`；提交门槛为 `5900ms`。按 2026-09-10 至 2026-09-20 的完整样本，订单响应附加延迟最短 `119ms`、中位数约 `348ms`，因此账号 1 预计约在 07:00:05.900 发单、最快约在 07:00:06.019 收到响应；账号 2 预计约在 07:00:06.200 发单。

这里需要区分两个概念：

- **提交门槛**：从验证码流程开始到发出订单请求的最短时间。
- **总结果时间**：从验证码流程开始到收到成功或失败响应的时间。

历史 6000ms 门槛的完整样本中，网络响应附加耗时为 `119–1136ms`。直接把门槛降到 5800ms，最快情况下可能在 `5919ms` 收到结果，低于 6 秒。因此当前采用 `5900ms`，是在“更早发单”和“结果尽量落在 6 秒以后”之间的折中。该值不是通用常量，网络环境或系统规则改变后应重新用日志评估。

> 5900ms 不能从数学上保证响应一定晚于 6 秒；它只是在现有历史样本中满足该目标。如果必须严格保证“收到结果时 ≥6000ms”，应将门槛保持为 6000ms 或更高。

### 4.6 双账号并发与 OCR

`run-daily.sh` 启动两个独立的 `test-submit.js` 进程：

- 每个账号读取自己的 auth 文件、手机号、同行人与场地配置。
- 第二账号通过 `--start-offset-ms 300` 将验证码、校验、提交和补抢基准整体后移。
- 每个账号启动一个独立 DDDDOCR worker，可并行识别，不互相排队。
- 两个 OCR worker 实测合计约占 `403 MiB RSS`，OCR 耗时约 `200–310ms`，当前机器资源足够。

如果未来机器内存不足，可以改为共享 OCR 服务，但共享模型会让第二个验证码在第一个识别较慢时排队，因此当前优先保留两个独立 worker。

双账号正式运行前必须先做 `--timing-test`。可复制 [双账号运行手册](docs/dual-account-runbook.md) 中的测试命令；测试会走到提交前并打印时间线，但绝不发送订单请求。


---

## 5. 调试 / 研究工具

`npm test` 运行离线回归检查，不联网、不读取账号、不提交订单，覆盖严格连续两小时、同一时段不重复选择多个场地，以及 `--timing-test` 与 `--execute` 互斥。

以下脚本用于抓包和接口调试，非日常抢场必需（账号名默认值可用命令行参数覆盖）：

| 脚本 | 用途 |
| --- | --- |
| `node capture-submit.mjs` | 用真实浏览器捕获「页面加载 → order/submit」的完整 API 调用序列，对比脚本与浏览器提交字段的差异 |
| `node dump-availability.mjs <账号> <日期>` | 直接调 `day/info` 接口，打印各场地各时段的可订状态 |
| `node dump-buddies.mjs <账号>` | 调 `buddies` 接口，核对配置里的同伴姓名能否匹配到 buddyId |

---

## 6. 目录 / 核心文件

| 文件 | 说明 |
| --- | --- |
| `reserve.js` | 浏览器页面预约主流程 |
| `test-submit.js` / `test-submit.sh` | 接口直提（含定时、五种模式、捡漏重试） |
| `run.sh` | 浏览器流程入口（login / reserve / inspect） |
| `add-account.sh` / `check-login.sh` | 新增账号 / 检查登录态 |
| `schedule-once*.sh` | 定时启动模板 |
| `solve_captcha.py` / `solve_captcha_worker.py` | DDDDOCR 验证码识别 |
| `config.example.json` | 配置模板 |
| `tests/retry-selection.cjs` | 离线补抢选择与提交模式校验，使用 `npm test` 运行 |
| `run-daily.sh` / `run-daily.local.example.sh` | 每日双账号入口与私有覆盖配置模板；复制为 `run-daily.local.sh` 后设置本机参数 |
| `docs/dual-account-runbook.md` | 双账号生产运行手册 |
| `docs/local-changes-vs-git.md` | 增强版相对固定历史 Git 基线的差异说明 |

---

## 7. 隐私与 .gitignore

以下内容已配置为 **Git 默认忽略**（含个人手机号、同伴、Cookie、token 及运行记录）：

- `config.json`、`run-daily.local.sh`、`memo.txt`、`.env*`
- `*-auth.json*`（登录态缓存及重新登录前备份）
- `.playwright-profile*/`（浏览器 profile）
- `logs`（目录或符号链接）、`*.log`、`*.pid`、`nohup.out`（运行日志与运行时文件）
- `backups/`（正式 runtime 的时间戳备份）
- `*.tar.gz`（打包备份）
- 截图 / 验证码样本目录

忽略规则不会移除已经跟踪的文件，也不能阻止 `git add -f`。分享仓库前应检查实际暂存内容及历史记录。

---

## 8. 注意事项

- 请确认自动化行为符合场馆系统规则，只在自己的账号和授权信息范围内使用。
- 验证码识别、接口签名等实现仅供学习研究。
