# BUAA Venue Helper 2

北航场馆预约辅助脚本，包含浏览器页面预约流程、验证码识别辅助，以及直接提交预约接口的测试脚本。

## 安装

```bash
npm install
npx playwright install chromium
pip install -r requirements.txt
pip install --no-deps ddddocr==1.6.1
```

如果不使用 GPU 版 ddddocr，可以按本机环境调整 `requirements.txt` 中的 onnxruntime 依赖。

## 配置

```bash
cp config.example.json config.json
```

然后编辑 `config.json`：

- `dateText`、`releaseTime`、`refreshDateTexts`：预约日期与放号时间。
- `accounts`：账号名、浏览器 profile、手机号、同行人和场地偏好。
- `slotPreferences`：默认场地与时间段。
- `captchaSolver`：可选 `ddddocr`、`gemini` 或超级鹰相关配置。

`config.json`、Playwright profile 和登录态缓存默认不会提交到 Git，避免把手机号、同行人、Cookie 或 token 公开。

## 使用

首次登录并写入本地浏览器 profile：

```bash
bash run.sh login --account default
```

正常预约：

```bash
bash run.sh reserve --account default
```

查看页面状态：

```bash
bash run.sh inspect --account default
```

直接提交接口测试：

```bash
bash test-submit.sh --account default --date 2026-04-17 --court '2号' --times '07:00-08:00' --with-captcha
```

实际执行提交时再加 `--execute`。

## 注意

请确认自动化行为符合场馆系统规则，并只在自己的账号和授权信息范围内使用。
