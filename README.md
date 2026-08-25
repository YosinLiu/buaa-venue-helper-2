# BUAA Venue Helper 2

北航场馆预约辅助脚本。支持浏览器页面预约流程、验证码识别（DDDDOCR / Gemini / 超级鹰），以及直接调用预约接口的定时抢场脚本，含多账号管理与「捡漏」重试。

> ⚠️ 仅用于本人账号及授权范围内的场地预约，请确认自动化行为符合场馆系统规则。

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

- 若不使用 GPU 版 ddddocr，可按本机环境调整 `requirements.txt` 里的 `onnxruntime` 依赖。
- 若系统已装 Chrome/Chromium，可在 `config.json` 里用 `browserExecutablePath` 指定，省去 `playwright install`。

---

## 2. 配置

```bash
cp config.example.json config.json
```

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

# 3. 验证（dry-run，不会真正提交）
bash test-submit.sh --account <账号名> --date 2026-05-16 \
  --court '9号' --times '20:00-21:00' --with-captcha --day-info-mode predict-no-captcha
```

看到 `DRY-RUN: 未提交` 且无报错即成功。

---

## 4. 使用

### 4.1 浏览器页面流程（run.sh）

```bash
bash run.sh login   --account default   # 首次登录并写入本地 profile
bash run.sh reserve --account default   # 正常预约
bash run.sh inspect --account default   # 查看页面状态
```

### 4.2 接口直提（test-submit.sh，推荐用于 07:00 抢场）

不加 `--execute` 时只 **dry-run** 打印将要提交的 payload；加 `--execute` 才真正提交。

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

**五种 `--day-info-mode` 策略：**

| 模式 | 说明 |
| --- | --- |
| `predict`（默认） | 提前解验证码 + 规则预测 timeId，到点直接提交（最快） |
| `poll` | 提前解验证码 + 到点轮询 day/info 用真实 ID 提交 |
| `predict-no-captcha` | 规则预测 ID，**到点后才解验证码**（07:00 放号推荐，避免跨天 token 失效） |
| `poll-no-captcha` | 到点后串行拉验证码 + 轮询 day/info，都就绪后提交 |
| `predict-late-check` | 提前 ~30s 完成 GET+OCR，到点后 CHECK+提交（兼顾速度与 07:00 token 安全，实验中） |

### 4.3 定时抢场（schedule-once.sh）

`schedule-once.sh` / `schedule-once-2.sh` 是**定时启动模板**：编辑顶部的 `ACCOUNT`、`TARGET_DATE`、`TARGET_TIME` 和底部的 `test-submit.sh` 参数，然后后台运行。到点前 sleep，到点自动发请求，日志与 PID 自动写入 `schedule-once-<账号>.log` / `.pid`。

```bash
# 编辑 schedule-once.sh 里的账号 / 日期 / 场地 / 时段，然后：
nohup bash schedule-once.sh &

# 想同时抢第二个账号，用 schedule-once-2.sh（内容同理，独立日志/PID）
nohup bash schedule-once-2.sh &

# 查看进度
tail -f schedule-once-<账号名>.log
```

### 4.4 捡漏重试（--retry-on-fail）

07:00 首轮没抢到时自动等待「锁单释放」捡漏：首次提交失败（非验证码原因）后，等待到锁单释放时刻开始每隔 1s 轮询 `day/info`，一旦出现空位（`status=1`）立即提交；所有目标时段都售罄（`status=4`）则提前退出。

```bash
bash test-submit.sh --at "07:00:00" --account <账号名> --date 2026-04-20 \
  --court '8号' --times '07:00-08:00' \
  --with-captcha --day-info-mode predict-no-captcha \
  --retry-on-fail \
  --retry-times '07:00-08:00,08:00-09:00,09:00-10:00' \
  --execute
```

相关参数：`--retry-window-ms`（捡漏总时长上限，默认 200s）、`--retry-poll-ms`（轮询间隔，默认 1s）、`--retry-times`（捡漏搜索的时段）、`--retry-court`（限定场地）、`--retry-max-slots`（最多选几个时段）。

---

## 5. 调试 / 研究工具

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

---

## 7. 隐私与 .gitignore

以下内容**不会提交到 Git**（含个人手机号、同伴、Cookie、token 及运行记录）：

- `config.json`、`memo.txt`、`.env*`
- `*-auth.json`（登录态缓存）
- `.playwright-profile*/`（浏览器 profile）
- `*.log`、`*.pid`、`nohup.out`（运行日志与运行时文件）
- `*.tar.gz`（打包备份）
- 截图 / 验证码样本目录

如需分享仓库，请再次确认没有把上述文件加入版本控制。

---

## 8. 注意事项

- 请确认自动化行为符合场馆系统规则，只在自己的账号和授权信息范围内使用。
- 验证码识别、接口签名等实现仅供学习研究。
