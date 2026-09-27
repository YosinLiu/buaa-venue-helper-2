import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const SCRIPT_START = Date.now();
function log(msg) {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  const elapsed = Date.now() - SCRIPT_START;
  console.log(`[${hh}:${mm}:${ss}.${ms} +${elapsed}ms] ${msg}`);
}

function formatClockWithMs(timestamp) {
  const d = new Date(timestamp);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const DOMAIN_URL = "https://cgyy.buaa.edu.cn";
const SERVER_URL = `${DOMAIN_URL}/venue-server`;
const DEFAULT_APP_KEY = "8fceb735082b5a529312040b58ea780b";
const DEFAULT_SIGN_SECRET = "c640ca392cd45fb3a55b00a63a86c618";
const DEFAULT_AES_KEY = "c1h2i5n6g2o2k4a7";
const DEFAULT_AES_IV = "C2H3I4N5G2O3K1E4";
const CAPTCHA_TYPE_CLICK_WORD = "clickWord";
const CAPTCHA_SUCCESS_CODE = "0000";
let REQUEST_VENUE_SITE_ID = 38;

// venue-site 38（1-12号）固定 spaceId
const SPACE_ID_MAP_38 = {
  "1号": 127, "2号": 128, "3号": 129, "4号": 130,
  "5号": 131, "6号": 132, "7号": 133, "8号": 134,
  "9号": 135, "10号": 136, "11号": 137, "12号": 142,
};

// venue-site 39（17-24号）固定 spaceId
const SPACE_ID_MAP_39 = {
  "17号": 143, "18号": 144, "19号": 145, "20号": 146,
  "21号": 147, "22号": 148, "23号": 149, "24号": 150,
};

// predict 模式 timeId 锚点（按星期几循环，每个 venue 独立）
// timeId = mondayBase + ((dayOfWeek + 6) % 7) * 15 + timeOffset
// dayOfWeek = date.getDay() in Beijing time (Sun=0, Mon=1, ..., Sat=6)
// timeOffset: 07:00→0, 08:00→1, ..., 21:00→14
const TIME_ID_ANCHORS = {
  38: { mondayBase: 8688 },  // 周一的 07:00 timeId
  39: { mondayBase: 9068 },
};

function getSpaceIdMap(venueSiteId, accountOverride) {
  const base = venueSiteId === 39 ? SPACE_ID_MAP_39 : SPACE_ID_MAP_38;
  return { ...base, ...(accountOverride || {}) };
}

function normalizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
用法:
  node test-submit.js --account account1
  node test-submit.js --account account2 --date 2026-04-15
  node test-submit.js --account account1 --execute

默认只打印将要 POST 的 payload，不会提交。
只有加 --execute 才会真正 POST 到 /api/reservation/order/submit。

可选参数:
  --account NAME              账号名，必填，多账号时例如 account1 / account2
  --date YYYY-MM-DD           预约日期；默认从 config.json 的 dateText 推导
  --court NAME                覆盖 config 里的场地，例如 6号
  --times A,B                 覆盖 config 里的时间，例如 07:00-08:00,19:00-20:00
  --with-captcha              提交前获取点选验证码，用 DDDDOCR 校验并填入 captchaVerification
  --captcha-attempts N        验证码识别/校验最多尝试次数，默认 3
  --captcha-offset-px N       [测试用] OCR 识别后将每个点偏移 +N 像素，默认 0（不偏移）
  --retry-on-fail             首次提交失败（非验证码原因）后，进入捡漏模式：
                              每隔 N ms 轮询 day/info，发现 status=1 立即提交；
                              全部目标时段变为 status=4（已售）时提前退出
  --retry-window-ms N         捡漏最长运行时间上限，默认 200000ms（200s）
  --retry-captcha-delay-ms N  开始时间 + N ms 时解补抢验证码，默认 90000ms（+90s）
  --retry-poll-delay-ms N     开始时间 + N ms 时轮询 day/info，默认 120000ms（+2min）
  --retry-poll-ms N           day/info 轮询间隔，默认 1000ms
  --retry-times A,B,C,D       捡漏时搜索的时间段（覆盖 config 里的 retrySlotPreferences），
                              例如 06:00-07:00,07:00-08:00,08:00-09:00,09:00-10:00
  --retry-court NAME          捡漏时的场地偏好（可选，不设置则搜索所有场地）
  --retry-any-court           补抢时忽略首轮场地，在当前场馆中选择任意可用场地
  --retry-max-slots N         捡漏提交时最多选择的时段数，默认 2
  --retry-require-all         补抢时要求所有指定时段同时可订，避免部分下单
  --retry-fallback-single     无同场完整时段时，降级为任意场地的一个目标时段
  --retry-prefer-consecutive-two  在目标范围内优先任意同场连续两小时，否则任意一个小时
  --retry-require-consecutive-two  只选任意同场连续两小时，不降级；优先于其他补抢选取选项
  --retry-submit-attempts N   补抢阶段最多发送 N 次订单请求，默认 1
  --submit-attempts N         首轮最多发送 N 次订单请求，默认 1
  --min-captcha-age-ms N      验证码从 get 到 submit 的最小间隔，默认 1300ms
  --min-captcha-check-age-ms N  验证码 check 完成到 submit 的最小间隔，默认 700ms
  --captcha-verification VAL  手动填入验证码 check 返回的 captchaVerification
  --payload FILE              直接读取 JSON payload，不自动查 day/info 和 buddies
  --execute                   真的提交；不加时仅 dry-run
  --timing-test               完整执行到提交前并计时，但绝不发送订单请求
  --headless                  无头打开账号 profile 读取登录态
  --save-auth                 启动浏览器读取登录态并保存到文件后退出（首次使用或登录过期时运行）
  --start-at TIME             到指定时刻才开始场地查询/验证码流程。支持 HH:MM[:SS] 或完整日期时间
  --start-offset-ms N         在 --start-at 基础上整体平移 N ms；负数提前、正数延后
  --server-safety-delay-ms N  服务器校时后的额外启动缓冲，默认 200ms；双账号精确错峰可设为 0
  --min-flow-duration-ms N    从流程开始到提交至少等待 N ms，默认 6000ms
  --at TIME                   目标提交时间，提前启动做好准备，到点发请求。支持 "HH:MM[:SS]" 或 "YYYY-MM-DD HH:MM[:SS]"
  --captcha-pre-window-ms N   predict/poll 模式下，在 --at 前 N ms 开始解验证码，默认 8000ms。
                              设为 0 表示在 --at 时刻才开始解（避免跨天 07:00 token 失效）
  --captcha-pre-ocr-window-ms N  predict-late-check 模式下，在 --at 前 N ms 完成 GET+OCR（CHECK 在 --at 后），默认 30000ms
  --day-info-mode MODE        预约策略（默认 predict）：
                                predict             —— 提前解验证码 + 规则预测 ID，到点直接提交（最快）
                                poll                —— 提前解验证码 + 到点轮询 day/info，用真实 ID 提交
                                predict-no-captcha  —— 规则预测 ID，到点后才解验证码再提交（避免 07:00 token 失效）
                                poll-no-captcha     —— 到点后串行拉验证码+轮询 day/info，都就绪后提交
                                predict-late-check  —— 提前 N 秒（默认30s）完成 GET+OCR，到点后 CHECK+提交（兼顾速度与 07:00 token 安全）
  --day-info-poll-interval-ms N  poll/poll-no-captcha 模式轮询间隔，默认 200ms
`);
}

function parseArgs(argv) {
  const args = {
    account: "",
    date: "",
    court: "",
    times: [],
    withCaptcha: false,
    captchaAttempts: 3,
    minCaptchaAgeMs: 1300,
    minCaptchaCheckAgeMs: 700,
    captchaOffsetPx: 0,
    retryOnFail: false,
    retryWindowMs: 200000,
    retryCaptchaDelayMs: 90000,
    retryPollDelayMs: 120000,
    retryPollMs: 1000,
    retryTimes: [],
    retryCourt: "",
    retryAnyCourt: false,
    retryMaxSlots: 2,
    retryRequireAll: false,
    retryFallbackSingle: false,
    retryPreferConsecutiveTwo: false,
    retryRequireConsecutiveTwo: false,
    retrySubmitAttempts: 1,
    captchaVerification: "",
    payloadFile: "",
    venueSiteId: 0,
    execute: false,
    submitAttempts: 1,
    timingTest: false,
    headless: false,
    saveAuth: false,
    startAt: "",
    startOffsetMs: 0,
    serverSafetyDelayMs: 200,
    minFlowDurationMs: 6000,
    at: "",
    dayInfoMode: "predict",
    dayInfoPollIntervalMs: 200,
    captchaPreWindowMs: 8000,
    captchaPreOcrWindowMs: 30000,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--execute") args.execute = true;
    else if (arg === "--timing-test") args.timingTest = true;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--with-captcha") args.withCaptcha = true;
    else if (arg === "--save-auth") args.saveAuth = true;
    else if (arg === "--start-at") args.startAt = normalizeText(argv[++i]);
    else if (arg.startsWith("--start-at=")) args.startAt = normalizeText(arg.slice("--start-at=".length));
    else if (arg === "--start-offset-ms") args.startOffsetMs = Number(argv[++i]) || 0;
    else if (arg.startsWith("--start-offset-ms=")) args.startOffsetMs = Number(arg.slice("--start-offset-ms=".length)) || 0;
    else if (arg === "--server-safety-delay-ms") args.serverSafetyDelayMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--server-safety-delay-ms=")) args.serverSafetyDelayMs = Math.max(0, Number(arg.slice("--server-safety-delay-ms=".length)) || 0);
    else if (arg === "--min-flow-duration-ms") args.minFlowDurationMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--min-flow-duration-ms=")) args.minFlowDurationMs = Math.max(0, Number(arg.slice("--min-flow-duration-ms=".length)) || 0);
    else if (arg === "--at") args.at = normalizeText(argv[++i]);
    else if (arg.startsWith("--at=")) args.at = normalizeText(arg.slice("--at=".length));
    else if (arg === "--day-info-mode") args.dayInfoMode = normalizeText(argv[++i]);
    else if (arg.startsWith("--day-info-mode=")) args.dayInfoMode = normalizeText(arg.slice("--day-info-mode=".length));
    else if (arg === "--day-info-poll-interval-ms") args.dayInfoPollIntervalMs = Math.max(50, Number(argv[++i]) || 200);
    else if (arg.startsWith("--day-info-poll-interval-ms=")) args.dayInfoPollIntervalMs = Math.max(50, Number(arg.slice("--day-info-poll-interval-ms=".length)) || 200);
    else if (arg === "--captcha-pre-window-ms") args.captchaPreWindowMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--captcha-pre-window-ms=")) args.captchaPreWindowMs = Math.max(0, Number(arg.slice("--captcha-pre-window-ms=".length)) || 0);
    else if (arg === "--captcha-pre-ocr-window-ms") args.captchaPreOcrWindowMs = Math.max(1000, Number(argv[++i]) || 30000);
    else if (arg.startsWith("--captcha-pre-ocr-window-ms=")) args.captchaPreOcrWindowMs = Math.max(1000, Number(arg.slice("--captcha-pre-ocr-window-ms=".length)) || 30000);
    else if (arg === "--captcha-attempts") args.captchaAttempts = Math.max(1, Number(argv[++i]) || 3);
    else if (arg.startsWith("--captcha-attempts=")) args.captchaAttempts = Math.max(1, Number(arg.slice("--captcha-attempts=".length)) || 3);
    else if (arg === "--min-captcha-age-ms") args.minCaptchaAgeMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--min-captcha-age-ms=")) args.minCaptchaAgeMs = Math.max(0, Number(arg.slice("--min-captcha-age-ms=".length)) || 0);
    else if (arg === "--min-captcha-check-age-ms") args.minCaptchaCheckAgeMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--min-captcha-check-age-ms=")) args.minCaptchaCheckAgeMs = Math.max(0, Number(arg.slice("--min-captcha-check-age-ms=".length)) || 0);
    else if (arg === "--captcha-offset-px") args.captchaOffsetPx = Number(argv[++i]) || 0;
    else if (arg.startsWith("--captcha-offset-px=")) args.captchaOffsetPx = Number(arg.slice("--captcha-offset-px=".length)) || 0;
    else if (arg === "--retry-on-fail") args.retryOnFail = true;
    else if (arg === "--retry-window-ms") args.retryWindowMs = Math.max(1000, Number(argv[++i]) || 60000);
    else if (arg.startsWith("--retry-window-ms=")) args.retryWindowMs = Math.max(1000, Number(arg.slice("--retry-window-ms=".length)) || 60000);
    else if (arg === "--retry-captcha-delay-ms") args.retryCaptchaDelayMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--retry-captcha-delay-ms=")) args.retryCaptchaDelayMs = Math.max(0, Number(arg.slice("--retry-captcha-delay-ms=".length)) || 0);
    else if (arg === "--retry-poll-delay-ms") args.retryPollDelayMs = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--retry-poll-delay-ms=")) args.retryPollDelayMs = Math.max(0, Number(arg.slice("--retry-poll-delay-ms=".length)) || 0);
    else if (arg === "--retry-poll-ms") args.retryPollMs = Math.max(200, Number(argv[++i]) || 1000);
    else if (arg.startsWith("--retry-poll-ms=")) args.retryPollMs = Math.max(200, Number(arg.slice("--retry-poll-ms=".length)) || 1000);
    else if (arg === "--retry-times") args.retryTimes = normalizeText(argv[++i]).split(",").map(normalizeText).filter(Boolean);
    else if (arg.startsWith("--retry-times=")) args.retryTimes = normalizeText(arg.slice("--retry-times=".length)).split(",").map(normalizeText).filter(Boolean);
    else if (arg === "--retry-court") args.retryCourt = normalizeText(argv[++i]);
    else if (arg.startsWith("--retry-court=")) args.retryCourt = normalizeText(arg.slice("--retry-court=".length));
    else if (arg === "--retry-any-court") args.retryAnyCourt = true;
    else if (arg === "--retry-max-slots") args.retryMaxSlots = Math.max(1, Number(argv[++i]) || 2);
    else if (arg.startsWith("--retry-max-slots=")) args.retryMaxSlots = Math.max(1, Number(arg.slice("--retry-max-slots=".length)) || 2);
    else if (arg === "--retry-require-all") args.retryRequireAll = true;
    else if (arg === "--retry-fallback-single") args.retryFallbackSingle = true;
    else if (arg === "--retry-prefer-consecutive-two") args.retryPreferConsecutiveTwo = true;
    else if (arg === "--retry-require-consecutive-two") args.retryRequireConsecutiveTwo = true;
    else if (arg === "--retry-submit-attempts") args.retrySubmitAttempts = Math.max(1, Number(argv[++i]) || 1);
    else if (arg.startsWith("--retry-submit-attempts=")) args.retrySubmitAttempts = Math.max(1, Number(arg.slice("--retry-submit-attempts=".length)) || 1);
    else if (arg === "--submit-attempts") args.submitAttempts = Math.max(1, Number(argv[++i]) || 1);
    else if (arg.startsWith("--submit-attempts=")) args.submitAttempts = Math.max(1, Number(arg.slice("--submit-attempts=".length)) || 1);
    else if (arg === "--account") args.account = normalizeText(argv[++i]);
    else if (arg.startsWith("--account=")) args.account = normalizeText(arg.slice("--account=".length));
    else if (arg === "--date") args.date = normalizeText(argv[++i]);
    else if (arg.startsWith("--date=")) args.date = normalizeText(arg.slice("--date=".length));
    else if (arg === "--court") args.court = normalizeText(argv[++i]);
    else if (arg.startsWith("--court=")) args.court = normalizeText(arg.slice("--court=".length));
    else if (arg === "--times") args.times = normalizeText(argv[++i]).split(",").map(normalizeText).filter(Boolean);
    else if (arg.startsWith("--times=")) args.times = normalizeText(arg.slice("--times=".length)).split(",").map(normalizeText).filter(Boolean);
    else if (arg === "--captcha-verification") args.captchaVerification = normalizeText(argv[++i]);
    else if (arg.startsWith("--captcha-verification=")) args.captchaVerification = normalizeText(arg.slice("--captcha-verification=".length));
    else if (arg === "--payload") args.payloadFile = normalizeText(argv[++i]);
    else if (arg.startsWith("--payload=")) args.payloadFile = normalizeText(arg.slice("--payload=".length));
    else if (arg === "--venue-site-id") args.venueSiteId = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith("--venue-site-id=")) args.venueSiteId = Math.max(0, Number(arg.slice("--venue-site-id=".length)) || 0);
  }

  return args;
}

function parseVenueSiteId(url) {
  const match = normalizeText(url).match(/\/venue-reservation\/(\d+)/);
  return match ? Number(match[1]) : 0;
}

function resolveVenueSiteId(account, args) {
  // 1. 显式参数 / 账号配置
  if (Number(args?.venueSiteId)) return Number(args.venueSiteId);
  if (Number(account.venueSiteId)) return Number(account.venueSiteId);
  // 2. 从场地名推断：1-12号 → 38，17-24号 → 39
  try {
    const slots = resolveSlotPreferences(account, args);
    for (const slot of slots) {
      const court = normalizeText(slot.court);
      if (SPACE_ID_MAP_39[court] !== undefined) return 39;
      if (SPACE_ID_MAP_38[court] !== undefined) return 38;
    }
  } catch { /* 无 slotPreferences 时跳过 */ }
  // 3. 从 URL 解析
  return parseVenueSiteId(account.url);
}

function parseTargetTime(str) {
  const s = normalizeText(str);
  // "YYYY-MM-DD HH:MM" or "YYYY-MM-DD HH:MM:SS"
  const full = s.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (full) {
    const [, year, month, day, hh, mm, ss = "00"] = full;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hh), Number(mm), Number(ss), 0).getTime();
  }
  // "HH:MM" or "HH:MM:SS"
  const time = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (time) {
    const [, hh, mm, ss = "00"] = time;
    const now = new Date();
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(hh), Number(mm), Number(ss), 0);
    if (candidate.getTime() <= now.getTime()) candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }
  throw new Error(`无法解析 --at 时间: ${str}。支持格式: HH:MM[:SS] 或 YYYY-MM-DD HH:MM[:SS]`);
}

function getAuthFilePath(account) {
  const userDataDir = normalizeText(account.userDataDir || ".playwright-profile");
  return path.resolve(process.cwd(), `${userDataDir}-auth.json`);
}

async function readAuthFromFile(account) {
  const filePath = getAuthFilePath(account);
  try {
    const text = await fs.readFile(filePath, "utf8");
    const data = JSON.parse(text);
    if (!data.cgAuthorization && !data.cookieHeader) return null;
    return data;
  } catch {
    return null;
  }
}

async function saveAuthToFile(account, auth) {
  const filePath = getAuthFilePath(account);
  await fs.writeFile(filePath, JSON.stringify({ ...auth, savedAt: new Date().toISOString() }, null, 2), "utf8");
  log(`登录态已保存: ${filePath}`);
}

function parseConfigDate(text, releaseTime = "") {
  const value = normalizeText(text);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const md = value.match(/(\d{1,2})月(\d{1,2})日/);
  if (!md) return "";

  const base = normalizeText(releaseTime).match(/^(\d{4})-/);
  const year = base ? Number(base[1]) : new Date().getFullYear();
  const month = md[1].padStart(2, "0");
  const day = md[2].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeTimeRange(value) {
  const text = normalizeText(value);
  const match = text.match(/(\d{1,2}):(\d{2}).*?(\d{1,2}):(\d{2})/);
  if (!match) return text;
  return `${match[1].padStart(2, "0")}:${match[2]}-${match[3].padStart(2, "0")}:${match[4]}`;
}

function itemText(item, keys) {
  for (const key of keys) {
    const value = normalizeText(item?.[key]);
    if (value) return value;
  }
  return "";
}

function timeLabel(item) {
  const direct = itemText(item, ["time", "timeName", "name", "showName", "label"]);
  if (direct && /\d{1,2}:\d{2}/.test(direct)) return normalizeTimeRange(direct);

  const begin = itemText(item, ["beginTime", "startTime", "startDate", "beginDate"]);
  const end = itemText(item, ["endTime", "endDate"]);
  if (begin && end) return normalizeTimeRange(`${begin}-${end}`);
  return normalizeTimeRange(direct);
}

function courtLabel(item) {
  return itemText(item, [
    "spaceName",
    "venueSpaceName",
    "venueSpaceEnName",
    "name",
    "siteName",
    "venueSiteName",
  ]);
}

function compactScalarData(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function signRequest(timestamp, apiPath, data, secret = DEFAULT_SIGN_SECRET) {
  let raw = `${secret}${apiPath}`;
  const clean = compactScalarData(data);
  for (const key of Object.keys(clean).sort()) {
    const value = clean[key];
    if (typeof value !== "object") {
      raw += `${key}${value}`;
    }
  }
  raw += `${timestamp} ${secret}`;
  return crypto.createHash("md5").update(raw).digest("hex");
}

function formEncode(data) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(compactScalarData(data))) {
    body.append(key, String(value));
  }
  return body.toString();
}

function cookieHeaderToMap(cookieHeader) {
  const map = new Map();
  for (const part of String(cookieHeader || "").split(";")) {
    const item = part.trim();
    if (!item) continue;
    const eq = item.indexOf("=");
    if (eq <= 0) continue;
    map.set(item.slice(0, eq), item.slice(eq + 1));
  }
  return map;
}

function mapToCookieHeader(map) {
  return [...map.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
}

function setCookieNameValue(setCookie) {
  const first = String(setCookie || "").split(";")[0].trim();
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  return { name: first.slice(0, eq), value: first.slice(eq + 1) };
}

function responseSetCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function mergeSetCookies(auth, setCookies) {
  if (!auth || !Array.isArray(setCookies) || setCookies.length === 0) return [];
  const map = cookieHeaderToMap(auth.cookieHeader);
  const names = [];
  for (const setCookie of setCookies) {
    const item = setCookieNameValue(setCookie);
    if (!item) continue;
    map.set(item.name, item.value);
    names.push(item.name);
    if (item.name === "cgAuthorization") {
      auth.cookieCgAuthorization = decodeURIComponent(item.value);
      if (!auth.dataSixAuth) auth.cgAuthorization = auth.cookieCgAuthorization;
    }
  }
  auth.cookieHeader = mapToCookieHeader(map);
  return names;
}

// 给坐标加 ±5px 随机抖动，模拟真实鼠标点击的自然偏差
function jitterCoords(coordStr, range = 5) {
  const [x, y] = String(coordStr).split(",").map(Number);
  const jx = Math.round(x + (Math.random() * 2 - 1) * range);
  const jy = Math.round(y + (Math.random() * 2 - 1) * range);
  return `${jx},${jy}`;
}

function encryptFrontendValue(value) {
  const cipher = crypto.createCipheriv(
    "aes-128-cbc",
    Buffer.from(DEFAULT_AES_KEY, "utf8"),
    Buffer.from(DEFAULT_AES_IV, "utf8"),
  );
  return Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]).toString("hex");
}

function encryptCaptchaValue(value, secretKey) {
  const cipher = crypto.createCipheriv("aes-128-ecb", Buffer.from(secretKey, "utf8"), null);
  return Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]).toString("base64");
}

function makeUuid(prefix) {
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${prefix}-${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function pngSize(buffer) {
  if (
    buffer.length >= 24
    && buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  return { width: 310, height: 155 };
}

function transformCaptchaCoords(coords, imageSize) {
  const width = imageSize.width || 310;
  const height = imageSize.height || 155;
  return coords.map((coord) => ({
    x: Math.round(310 * Number(coord[0]) / width),
    y: Math.round(155 * Number(coord[1]) / height),
  }));
}

async function readConfig() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, "utf8"));
  const base = { ...config };
  delete base.accounts;
  const accounts = Array.isArray(config.accounts) && config.accounts.length > 0
    ? config.accounts.map((account) => ({ ...base, ...account }))
    : [{ ...base, name: normalizeText(config.name || "default") }];
  return { config, accounts };
}

function selectAccount(accounts, accountName) {
  if (!accountName && accounts.length === 1) return accounts[0];
  const account = accounts.find((item) => normalizeText(item.name || item.accountName) === accountName);
  if (!account) {
    throw new Error(`没有找到账号配置: ${accountName || "(未指定)"}`);
  }
  return account;
}

function resolveSlotPreferences(account, args) {
  if (args.court || args.times.length > 0) {
    if (!args.court || args.times.length === 0) {
      throw new Error("--court 和 --times 需要一起提供");
    }
    return [{ court: args.court, times: args.times }];
  }
  const slots = Array.isArray(account.slotPreferences) ? account.slotPreferences : [];
  return slots.map((slot) => ({
    court: normalizeText(slot.court),
    times: Array.isArray(slot.times) ? slot.times.map(normalizeText).filter(Boolean) : [],
  })).filter((slot) => slot.court && slot.times.length > 0);
}

function resolveRetrySlotPreferences(account, args) {
  // 1. CLI --retry-times
  if (args.retryTimes.length > 0) {
    const court = args.retryAnyCourt ? "" : (args.retryCourt || args.court || "");
    return [{ court, times: args.retryTimes }];
  }
  // 2. config.json account 级别 retrySlotPreferences
  const retrySlots = Array.isArray(account.retrySlotPreferences) ? account.retrySlotPreferences : [];
  const parsed = retrySlots.map((slot) => ({
    court: normalizeText(slot.court),
    times: Array.isArray(slot.times) ? slot.times.map(normalizeText).filter(Boolean) : [],
  })).filter((slot) => slot.times.length > 0);
  if (parsed.length > 0) return parsed;
  // 3. 回退到普通 slotPreferences
  return resolveSlotPreferences(account, args);
}

async function launchProfile(account, args) {
  const userDataDir = path.resolve(process.cwd(), account.userDataDir || ".playwright-profile");
  const executablePath = normalizeText(account.browserExecutablePath);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: args.headless,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: null,
    args: ["--start-maximized"],
    ...(executablePath ? { executablePath: path.resolve(process.cwd(), executablePath) } : {}),
  });
  const page = context.pages()[0] || await context.newPage();
  return { context, page };
}

async function readAuthFromBrowser(context, page) {
  await page.goto(`${DOMAIN_URL}/venue/venue-reservation/38`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(800);
  const browserState = await page.evaluate(() => {
    const uuid = (prefix) => {
      const chars = [];
      const dict = "0123456789abcdef";
      for (let i = 0; i < 36; i += 1) chars[i] = dict.substr(Math.floor(16 * Math.random()), 1);
      chars[14] = "4";
      chars[19] = dict.substr((3 & Number.parseInt(chars[19], 16)) | 8, 1);
      chars[8] = chars[13] = chars[18] = chars[23] = "-";
      return `${prefix}-${chars.join("")}`;
    };
    const readCookie = (name) => {
      const found = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
      return found ? decodeURIComponent(found.slice(name.length + 1)) : "";
    };
    if (!localStorage.getItem("point")) localStorage.setItem("point", uuid("point"));
    if (!localStorage.getItem("slider")) localStorage.setItem("slider", uuid("slider"));
    const dataSixAuth = localStorage.getItem("dataSix") || "";
    const cookieCgAuthorization = readCookie("cgAuthorization");
    return {
      cgAuthorization: dataSixAuth || cookieCgAuthorization || localStorage.getItem("cgAuthorization") || "",
      dataSixAuth,
      cookieCgAuthorization,
      fp: readCookie("_zte_fp_"),
      pointClientUid: localStorage.getItem("point") || "",
      sliderClientUid: localStorage.getItem("slider") || "",
    };
  });
  const cookies = await context.cookies(DOMAIN_URL);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  return { ...browserState, cookieHeader };
}

async function apiRequest(apiPath, options, auth) {
  const method = normalizeText(options.method || "GET").toUpperCase();
  const timestamp = Date.now();
  const data = { ...(options.data || {}) };
  if (method === "GET") {
    // 用 ms*1000 + random(0..999) 提升精度，避免并发 GET 请求 timestamp 同毫秒导致 sign 碰撞
    // （服务器/网关可能按 sign 去重，会把另一个账号的响应返回过来）
    data.nocache = timestamp * 1000 + Math.floor(Math.random() * 1000);
  }
  const cleanData = compactScalarData(data);
  const sign = signRequest(timestamp, apiPath, cleanData);
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Origin: DOMAIN_URL,
    Referer: `${DOMAIN_URL}/venue/venue-reservation/${REQUEST_VENUE_SITE_ID}`,
    "app-key": DEFAULT_APP_KEY,
    timestamp: String(timestamp),
    sign,
    ...(auth?.cookieHeader ? { Cookie: auth.cookieHeader } : {}),
  };
  if (auth?.dataSixAuth) headers.cgAuthorization = auth.dataSixAuth;
  if (auth?.cookieCgAuthorization) {
    headers.cgappauthorization = auth.cookieCgAuthorization;
    if (!headers.cgAuthorization) headers.cgAuthorization = auth.cookieCgAuthorization;
  } else if (auth?.cgAuthorization) {
    headers.cgAuthorization = auth.cgAuthorization;
  }

  const query = method === "GET" ? formEncode(cleanData) : "";
  const url = `${SERVER_URL}${apiPath}${query ? `?${query}` : ""}`;
  const startedAt = Date.now();
  const response = await fetch(url, {
    method,
    headers,
    body: method === "GET" ? undefined : formEncode(cleanData),
  });
  const setCookieNames = mergeSetCookies(auth, responseSetCookies(response.headers));
  const elapsedMs = Date.now() - startedAt;
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Keep raw text below.
  }
  return {
    status: response.status,
    ok: response.ok,
    elapsedMs,
    url,
    finalUrl: response.url,
    setCookieNames,
    body: json,
    text,
  };
}

// 测量本机与服务器的时钟偏差（serverTime - localTime，毫秒）
// 正值 = 服务器快，负值 = 服务器慢。精度约 ±500ms（Date 头秒级）
async function measureServerClockOffset() {
  const localBefore = Date.now();
  let resp;
  try {
    resp = await fetch(`${DOMAIN_URL}/venue/venue-reservation/38`, { method: "HEAD" });
  } catch {
    return null;
  }
  const localAfter = Date.now();
  const serverDateStr = resp.headers.get("date");
  if (!serverDateStr) return null;
  const serverMs = new Date(serverDateStr).getTime();
  if (isNaN(serverMs)) return null;
  // 用请求中点估算服务器时间对应的本机时刻
  const localMid = Math.round((localBefore + localAfter) / 2);
  return serverMs - localMid;
}

async function readServerClockSample() {
  if (process.env.BUAA_FORCE_CLOCK_FAILURE === "1") {
    throw new Error("forced clock calibration failure");
  }
  const nonce = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const url = `${DOMAIN_URL}/venue/venue-reservation/${REQUEST_VENUE_SITE_ID}?_clock=${nonce}`;
  const localBefore = Date.now();
  const response = await fetch(url, {
    method: "HEAD",
    cache: "no-store",
    signal: AbortSignal.timeout(1500),
    headers: {
      "Cache-Control": "no-cache, no-store, max-age=0",
      Pragma: "no-cache",
    },
  });
  const localAfter = Date.now();
  const serverDateText = response.headers.get("date");
  const serverTime = serverDateText ? new Date(serverDateText).getTime() : NaN;
  if (!Number.isFinite(serverTime)) {
    throw new Error("预约服务器未返回有效 Date 响应头，拒绝提前获取验证码。");
  }
  return {
    serverTime,
    serverDateText,
    localBefore,
    localAfter,
    rttMs: localAfter - localBefore,
    lowerBoundOffsetMs: serverTime - localAfter,
    midpointOffsetMs: serverTime + 500 - Math.round((localBefore + localAfter) / 2),
  };
}

async function calibrateServerClockBefore(targetTime, label = "服务器时间预校准") {
  // 在首轮目标前一分钟完成一次校准。首轮和补抢均复用结果，不再访问校时地址。
  const calibrationLeadMs = 60000;
  const preWaitMs = targetTime - Date.now() - calibrationLeadMs;
  if (preWaitMs > 0) await sleep(preWaitMs);

  const samples = [];
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    // 正常任务在提前一分钟取样；若进程晚启动，最迟保留 2.5 秒安全边界。
    if (Date.now() >= targetTime - 2500) break;
    try {
      samples.push(await readServerClockSample());
    } catch (error) {
      log(`${label}第 ${attempt} 次失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (attempt < 8) await sleep(180);
  }
  if (samples.length === 0) {
    log(`${label}未取得有效服务器样本；降级使用本机 NTP 时间，任务继续执行。`);
    return {
      lowerBoundOffsetMs: 0,
      midpointOffsetMs: 0,
      samples: [],
      fallback: "local-ntp",
    };
  }

  // Date 头只有整秒精度。serverTime - localAfter 是服务器偏差的保守下界；
  // 用所有样本中最大的下界，可以保证推算出的发送时刻不会早于服务器目标时间。
  const lowerBoundOffsetMs = Math.max(...samples.map((sample) => sample.lowerBoundOffsetMs));
  const midpointOffsets = samples.map((sample) => sample.midpointOffsetMs).sort((a, b) => a - b);
  const midpointOffsetMs = midpointOffsets[Math.floor(midpointOffsets.length / 2)];
  log(`${label}完成：样本=${samples.length}，估计偏差=${midpointOffsetMs}ms，保守下界=${lowerBoundOffsetMs}ms；后续所有时间门复用本结果。`);
  return { lowerBoundOffsetMs, midpointOffsetMs, samples };
}

async function waitWithServerCalibration(targetTime, calibration, label = "服务器时间门", safetyDelayMs = 200) {
  if (!calibration) {
    log(`${label}缺少服务器校准结果；降级使用本机 NTP 时间。`);
    calibration = { lowerBoundOffsetMs: 0, midpointOffsetMs: 0, samples: [], fallback: "local-ntp" };
  }
  const localReleaseTime = Math.max(
    targetTime + safetyDelayMs,
    targetTime + safetyDelayMs - calibration.lowerBoundOffsetMs,
  );
  const sourceLabel = calibration.fallback === "local-ntp" ? "本机 NTP 回退" : "首轮服务器预校准";
  log(`${label}计划本机触发=${formatClockWithMs(localReleaseTime)}（使用${sourceLabel}，不再联网校时）`);
  const waitMs = localReleaseTime - Date.now();
  if (waitMs > 0) await sleep(waitMs);
  log(`${label}通过：按预校准结果已超过目标服务器时间至少 ${safetyDelayMs}ms。`);
  return { ...calibration, localReleaseTime };
}

function unwrapApiData(result, label) {
  const body = result.body;
  if (!body) {
    throw new Error(`${label} 返回非 JSON: http=${result.status} url=${result.finalUrl || result.url} body=${result.text.slice(0, 200)}`);
  }
  if (body.code && body.code !== 200) {
    throw new Error(`${label} 返回 code=${body.code}: ${body.message || body.msg || JSON.stringify(body).slice(0, 200)}`);
  }
  return body.data ?? body;
}

function captchaRepOk(data) {
  const repCode = normalizeText(data?.repCode ?? data?.code);
  return !repCode || repCode === CAPTCHA_SUCCESS_CODE || repCode === "200";
}

function captchaRepMessage(data) {
  return normalizeText(data?.repMsg || data?.message || data?.msg || JSON.stringify(data || {}).slice(0, 200));
}

function parseSolverOutput(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Try previous line.
    }
  }
  throw new Error(`DDDDOCR 输出不是 JSON: ${String(stdout || "").slice(0, 300)}`);
}

async function solveCaptchaImage(account, imageBuffer, wordList, worker) {
  const mode = normalizeText(account.captchaDdddocrMode || "preproc_color_probagg");
  const startedAt = Date.now();
  if (worker) {
    const result = await worker.solve(imageBuffer, wordList, mode);
    return { result, elapsedMs: Date.now() - startedAt, mode };
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "buaa-captcha-"));
  const imagePath = path.join(tempDir, "captcha.png");
  try {
    await fs.writeFile(imagePath, imageBuffer);
    const pythonBin = normalizeText(account.pythonBin || "python3");
    const { stdout } = await execFileAsync(
      pythonBin,
      [
        path.resolve(process.cwd(), "solve_captcha.py"),
        "--image",
        imagePath,
        "--mode",
        mode,
        "--image-area-ratio",
        "1",
        "--targets",
        ...wordList,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return { result: parseSolverOutput(stdout), elapsedMs: Date.now() - startedAt, mode };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

class CaptchaWorker {
  constructor(proc) {
    this._proc = proc;
    this._pending = new Map();
    this._nextId = 1;
    this._readyResolve = null;
    this._readyReject = null;
    this.readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "ready") { this._readyResolve(); return; }
        const entry = this._pending.get(msg.id);
        if (!entry) return;
        this._pending.delete(msg.id);
        if (msg.error) entry.reject(new Error(`ddddocr worker: ${msg.error}`));
        else entry.resolve(msg);
      } catch { /* ignore bad lines */ }
    });
    proc.on("error", (err) => this._readyReject(err));
    proc.on("exit", (code) => {
      this._readyReject(new Error(`ddddocr worker exited: ${code}`));
      for (const { reject } of this._pending.values()) reject(new Error(`ddddocr worker exited: ${code}`));
      this._pending.clear();
    });
  }

  solve(imageBuffer, wordList, mode) {
    const id = String(this._nextId++);
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._proc.stdin.write(JSON.stringify({ id, image_base64: imageBuffer.toString("base64"), targets: wordList, mode }) + "\n");
    });
  }

  close() { this._proc.stdin.end(); }
}

function startCaptchaWorker(account) {
  const pythonBin = normalizeText(account.pythonBin || "python3");
  const proc = spawn(pythonBin, [path.resolve(process.cwd(), "solve_captcha_worker.py")], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  return new CaptchaWorker(proc);
}

async function resolveCaptchaVerification(account, args, auth, worker) {
  const captchaType = normalizeText(account.captchaType || CAPTCHA_TYPE_CLICK_WORD);
  const clientUid = auth.pointClientUid || makeUuid("point");
  let lastError = "";

  for (let attempt = 1; attempt <= args.captchaAttempts; attempt += 1) {
    if (attempt > 1) log(`验证码重试第 ${attempt} 次`);
    const captchaStartedAt = Date.now();
    log("GET /api/captcha/get");
    const getResult = await apiRequest("/api/captcha/get", {
      data: {
        captchaType,
        clientUid,
        ts: Date.now(),
      },
    }, auth);
    log(`captcha/get 完成 (+${getResult.elapsedMs}ms)`);
    const getData = unwrapApiData(getResult, "/api/captcha/get");
    if (!captchaRepOk(getData)) {
      lastError = `get repCode=${getData.repCode}: ${captchaRepMessage(getData)}`;
      continue;
    }

    const repData = getData.repData || getData;
    const wordList = Array.isArray(repData.wordList) ? repData.wordList.map(normalizeText).filter(Boolean) : [];
    const imageBase64 = normalizeText(repData.originalImageBase64);
    const backToken = normalizeText(repData.token);
    const secretKey = normalizeText(repData.secretKey);
    if (!imageBase64 || !backToken || wordList.length === 0) {
      lastError = `get 返回缺字段: ${JSON.stringify(Object.keys(repData || {}))}`;
      continue;
    }

    const imageBuffer = Buffer.from(imageBase64, "base64");
    const imageSize = pngSize(imageBuffer);
    log(`OCR 识别中 [${wordList.join(",")}]${worker ? " (worker)" : ""}`);
    const solver = await solveCaptchaImage(account, imageBuffer, wordList, worker);
    log(`OCR 完成 (+${solver.elapsedMs}ms)`);
    const coords = Array.isArray(solver.result.coords) ? solver.result.coords : [];
    const found = Array.isArray(solver.result.found) ? solver.result.found : [];
    if (solver.result.error || coords.length < wordList.length || found.some((item) => !item) || coords.some((item) => !item)) {
      lastError = `DDDDOCR 未完整识别: ${JSON.stringify(solver.result)}`;
      continue;
    }

    const checkPosArr = transformCaptchaCoords(coords, imageSize);
    if (args.captchaOffsetPx) {
      for (const pos of checkPosArr) {
        pos.x = (pos.x || 0) + args.captchaOffsetPx;
        pos.y = (pos.y || 0) + args.captchaOffsetPx;
      }
      log(`[TEST] 坐标偏移 +${args.captchaOffsetPx}px → ${JSON.stringify(checkPosArr)}`);
    }
    const checkPayload = {
      captchaType,
      pointJson: secretKey
        ? encryptCaptchaValue(JSON.stringify(checkPosArr), secretKey)
        : JSON.stringify(checkPosArr),
      token: backToken,
    };
    log("POST /api/captcha/check");
    const checkResult = await apiRequest("/api/captcha/check", {
      method: "POST",
      data: checkPayload,
    }, auth);
    const captchaCheckedAt = Date.now();
    log(`captcha/check 完成 (+${checkResult.elapsedMs}ms)`);
    const checkData = unwrapApiData(checkResult, "/api/captcha/check");
    const debug = {
      attempt,
      captchaType,
      getMs: getResult.elapsedMs,
      ocrMs: solver.elapsedMs,
      checkMs: checkResult.elapsedMs,
      getSetCookies: getResult.setCookieNames,
      checkSetCookies: checkResult.setCookieNames,
      ddddocrMode: solver.mode,
      captchaAgeMsAtCheckEnd: Date.now() - captchaStartedAt,
      minCaptchaAgeMs: args.minCaptchaAgeMs,
      imageSize,
      wordList,
      coords,
      checkPosArr,
      repCode: checkData?.repCode,
      repMsg: checkData?.repMsg,
      checkDataKeys: Object.keys(checkData || {}).sort(),
    };

    if (captchaRepOk(checkData)) {
      return {
        captchaVerification: secretKey
          ? encryptCaptchaValue(`${backToken}---${JSON.stringify(checkPosArr)}`, secretKey)
          : `${backToken}---${JSON.stringify(checkPosArr)}`,
        captchaToken: backToken,
        captchaStartedAt,
        captchaCheckedAt,
        debug,
      };
    }
    lastError = `check repCode=${checkData?.repCode}: ${captchaRepMessage(checkData)}; debug=${JSON.stringify(debug)}`;
  }

  throw new Error(`验证码校验失败，已尝试 ${args.captchaAttempts} 次。最后错误: ${lastError}`);
}

// predict-late-check 专用：Phase 1 — GET + OCR，不做 CHECK，返回中间状态
async function resolveCaptchaGetOcr(account, args, auth, worker) {
  const captchaType = normalizeText(account.captchaType || CAPTCHA_TYPE_CLICK_WORD);
  const clientUid = auth.pointClientUid || makeUuid("point");
  let lastError = "";
  for (let attempt = 1; attempt <= args.captchaAttempts; attempt++) {
    if (attempt > 1) log(`验证码 GET/OCR 重试第 ${attempt} 次`);
    const captchaStartedAt = Date.now();
    log("GET /api/captcha/get");
    const getResult = await apiRequest("/api/captcha/get", {
      data: { captchaType, clientUid, ts: Date.now() },
    }, auth);
    log(`captcha/get 完成 (+${getResult.elapsedMs}ms)`);
    const getData = unwrapApiData(getResult, "/api/captcha/get");
    if (!captchaRepOk(getData)) {
      lastError = `get repCode=${getData.repCode}: ${captchaRepMessage(getData)}`;
      continue;
    }
    const repData = getData.repData || getData;
    const wordList = Array.isArray(repData.wordList) ? repData.wordList.map(normalizeText).filter(Boolean) : [];
    const imageBase64 = normalizeText(repData.originalImageBase64);
    const backToken = normalizeText(repData.token);
    const secretKey = normalizeText(repData.secretKey);
    if (!imageBase64 || !backToken || wordList.length === 0) {
      lastError = `get 返回缺字段: ${JSON.stringify(Object.keys(repData || {}))}`;
      continue;
    }
    const imageBuffer = Buffer.from(imageBase64, "base64");
    const imageSize = pngSize(imageBuffer);
    log(`OCR 识别中 [${wordList.join(",")}]${worker ? " (worker)" : ""}`);
    const solver = await solveCaptchaImage(account, imageBuffer, wordList, worker);
    log(`OCR 完成 (+${solver.elapsedMs}ms)`);
    const coords = Array.isArray(solver.result.coords) ? solver.result.coords : [];
    const found = Array.isArray(solver.result.found) ? solver.result.found : [];
    if (solver.result.error || coords.length < wordList.length || found.some((x) => !x) || coords.some((x) => !x)) {
      lastError = `DDDDOCR 未完整识别: ${JSON.stringify(solver.result)}`;
      continue;
    }
    const checkPosArr = transformCaptchaCoords(coords, imageSize);
    if (args.captchaOffsetPx) {
      for (const pos of checkPosArr) {
        pos.x = (pos.x || 0) + args.captchaOffsetPx;
        pos.y = (pos.y || 0) + args.captchaOffsetPx;
      }
      log(`[TEST] 坐标偏移 +${args.captchaOffsetPx}px → ${JSON.stringify(checkPosArr)}`);
    }
    return { captchaStartedAt, captchaType, backToken, secretKey, checkPosArr, wordList, coords, imageSize,
      getMs: getResult.elapsedMs, ocrMs: solver.elapsedMs, ddddocrMode: solver.mode, attempt };
  }
  throw new Error(`验证码 GET/OCR 失败，已尝试 ${args.captchaAttempts} 次。最后错误: ${lastError}`);
}

// predict-late-check 专用：Phase 2 — 仅做 CHECK，接受 resolveCaptchaGetOcr 的返回值
async function resolveCaptchaCheckOnly(auth, getOcrResult) {
  const { captchaType, backToken, secretKey, checkPosArr } = getOcrResult;
  const checkPayload = {
    captchaType,
    pointJson: secretKey
      ? encryptCaptchaValue(JSON.stringify(checkPosArr), secretKey)
      : JSON.stringify(checkPosArr),
    token: backToken,
  };
  log("POST /api/captcha/check");
  const checkResult = await apiRequest("/api/captcha/check", { method: "POST", data: checkPayload }, auth);
  const captchaCheckedAt = Date.now();
  log(`captcha/check 完成 (+${checkResult.elapsedMs}ms)`);
  const checkData = unwrapApiData(checkResult, "/api/captcha/check");
  if (!captchaRepOk(checkData)) {
    throw new Error(`check repCode=${checkData?.repCode}: ${captchaRepMessage(checkData)}`);
  }
  return {
    captchaVerification: secretKey
      ? encryptCaptchaValue(`${backToken}---${JSON.stringify(checkPosArr)}`, secretKey)
      : `${backToken}---${JSON.stringify(checkPosArr)}`,
    captchaToken: backToken,
    captchaStartedAt: getOcrResult.captchaStartedAt,
    captchaCheckedAt,
    checkMs: checkResult.elapsedMs,
  };
}

function flattenSpaces(dayInfo, targetDate) {
  const byDate = dayInfo?.reservationDateSpaceInfo || {};
  if (Array.isArray(byDate[targetDate])) return byDate[targetDate];
  const values = Object.values(byDate).filter(Array.isArray).flat();
  if (values.length > 0) return values;
  for (const key of ["venueSpaceList", "spaceList", "tableVenueSite", "groupInfo"]) {
    if (Array.isArray(dayInfo?.[key])) return dayInfo[key];
  }
  return [];
}

function findSpace(spaces, court) {
  const target = normalizeText(court);
  return spaces.find((space) => courtLabel(space) === target)
    || spaces.find((space) => courtLabel(space).includes(target) || target.includes(courtLabel(space)));
}

function findTime(times, desiredTime) {
  const target = normalizeTimeRange(desiredTime);
  return times.find((time) => timeLabel(time) === target)
    || times.find((time) => timeLabel(time).includes(target) || target.includes(timeLabel(time)));
}

function buildReservationOrder(dayInfo, slotPreferences, targetDate) {
  const times = Array.isArray(dayInfo?.spaceTimeInfo) ? dayInfo.spaceTimeInfo : [];
  const spaces = flattenSpaces(dayInfo, targetDate);
  if (times.length === 0) throw new Error("day/info 里没有 spaceTimeInfo，无法映射 timeId");
  if (spaces.length === 0) throw new Error("day/info 里没有 reservationDateSpaceInfo，无法映射 spaceId");

  const orderItems = [];
  const debug = [];
  let orderPrice = 0;
  for (const slot of slotPreferences) {
    const space = findSpace(spaces, slot.court);
    if (!space) {
      throw new Error(`没有在 day/info 中找到场地: ${slot.court}`);
    }
    for (const desiredTime of slot.times) {
      const time = findTime(times, desiredTime);
      if (!time) {
        throw new Error(`没有在 day/info 中找到时间: ${desiredTime}`);
      }
      const item = { spaceId: space.id, timeId: time.id };
      if (space.venueSpaceGroupId) item.venueSpaceGroupId = space.venueSpaceGroupId;
      orderItems.push(item);
      const cell = space?.[time.id] || space?.[String(time.id)] || {};
      const fee = Number(cell.orderFee ?? cell.price ?? cell.payFee ?? 0);
      if (Number.isFinite(fee)) orderPrice += fee;
      debug.push({
        court: slot.court,
        courtMatched: courtLabel(space),
        time: normalizeTimeRange(desiredTime),
        timeMatched: timeLabel(time),
        spaceId: space.id,
        timeId: time.id,
        venueSpaceGroupId: space.venueSpaceGroupId || null,
        orderFee: Number.isFinite(fee) ? fee : null,
      });
    }
  }
  return { orderItems, debug, orderPrice };
}

// 捡漏重试用：收集所有 status=1 的场地/时段组合。
function findAvailableRetryItems(dayInfo, slotPreferences, targetDate) {
  const times = Array.isArray(dayInfo?.spaceTimeInfo) ? dayInfo.spaceTimeInfo : [];
  const spaces = flattenSpaces(dayInfo, targetDate);
  const result = [];
  for (const slot of slotPreferences) {
    const targetCourt = normalizeText(slot.court);
    for (const desiredTime of slot.times) {
      const time = findTime(times, desiredTime);
      if (!time) continue;
      for (const space of spaces) {
        if (targetCourt && courtLabel(space) !== targetCourt) continue;
        const cell = space[String(time.id)];
        if (cell && cell.reservationStatus === 1 && space.id) {
          result.push({
            spaceId: space.id,
            timeId: time.id,
            orderFee: Number(cell.orderFee ?? 0),
            spaceName: cell.spaceName,
            timeRange: normalizeTimeRange(desiredTime),
          });
        }
      }
    }
  }
  return result;
}

// 要求所有目标时段在同一个场地连续可订；场地未指定时选择第一个满足条件的场地。
function selectCompleteRetryCourt(availableItems, slotPreferences) {
  const requiredTimes = [...new Set(
    slotPreferences.flatMap((slot) => slot.times.map(normalizeTimeRange)),
  )];
  const bySpace = new Map();
  for (const item of availableItems) {
    if (!bySpace.has(item.spaceId)) bySpace.set(item.spaceId, []);
    bySpace.get(item.spaceId).push(item);
  }
  for (const [, items] of bySpace) {
    const selected = [];
    for (const targetTime of requiredTimes) {
      const item = items.find((candidate) => candidate.timeRange === targetTime);
      if (!item) break;
      selected.push(item);
    }
    if (selected.length === requiredTimes.length) return selected;
  }
  return [];
}

// 在任意场地中优先选择连续两个小时；fallbackSingle=false 时只接受完整两小时。
function selectPreferredConsecutiveTwo(availableItems, fallbackSingle = true) {
  function startHour(item) {
    const match = item.timeRange.match(/^(\d{2}):(\d{2})/);
    return match ? Number(match[1]) + Number(match[2]) / 60 : -1;
  }

  const bySpace = new Map();
  for (const item of availableItems) {
    if (!fallbackSingle) {
      const match = item.timeRange.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
      if (!match || (Number(match[3]) * 60 + Number(match[4]))
          - (Number(match[1]) * 60 + Number(match[2])) !== 60) continue;
    }
    if (!bySpace.has(item.spaceId)) bySpace.set(item.spaceId, []);
    bySpace.get(item.spaceId).push(item);
  }
  for (const [, items] of bySpace) {
    const sorted = [...items].sort((a, b) => startHour(a) - startHour(b));
    for (let index = 1; index < sorted.length; index += 1) {
      if (Math.abs(startHour(sorted[index]) - startHour(sorted[index - 1]) - 1) < 0.01) {
        return [sorted[index - 1], sorted[index]];
      }
    }
  }
  return fallbackSingle && availableItems.length > 0 ? [availableItems[0]] : [];
}

// 从可用捡漏项中选最优子集（最多 maxSlots 个，优先同场地连续时段）
function selectBestRetryItems(availableItems, maxSlots) {
  function selectDistinctTimes(items) {
    const selected = [];
    const usedTimes = new Set();
    for (const item of items) {
      const timeKey = item.timeRange || item.timeId;
      if (usedTimes.has(timeKey)) continue;
      usedTimes.add(timeKey);
      selected.push(item);
      if (selected.length >= maxSlots) break;
    }
    return selected;
  }

  if (availableItems.length <= maxSlots) return selectDistinctTimes(availableItems);

  function startHour(item) {
    const m = item.timeRange.match(/^(\d{2}):(\d{2})/);
    return m ? Number(m[1]) + Number(m[2]) / 60 : -1;
  }

  // 按场地分组
  const bySpace = new Map();
  for (const item of availableItems) {
    if (!bySpace.has(item.spaceId)) bySpace.set(item.spaceId, []);
    bySpace.get(item.spaceId).push(item);
  }

  // 在每个场地内找最长连续序列
  let bestRun = [];
  for (const [, items] of bySpace) {
    const sorted = [...items].sort((a, b) => startHour(a) - startHour(b));
    let run = [sorted[0]];
    for (let i = 1; i < sorted.length; i++) {
      if (Math.abs(startHour(sorted[i]) - startHour(sorted[i - 1]) - 1) < 0.01) {
        run.push(sorted[i]);
      } else {
        if (run.length > bestRun.length) bestRun = run;
        run = [sorted[i]];
      }
    }
    if (run.length > bestRun.length) bestRun = run;
  }

  if (bestRun.length >= maxSlots) return bestRun.slice(0, maxSlots);

  // 连续序列不够长时补足其他时段，避免同一小时选择多个场地。
  return selectDistinctTimes([...bestRun, ...availableItems]);
}

// 捡漏提前退出：目标的每个时段，在所有场地中均为 status=4（已售），则放弃
function allTargetSlotsSoldOut(dayInfo, slotPreferences, targetDate) {
  const times = Array.isArray(dayInfo?.spaceTimeInfo) ? dayInfo.spaceTimeInfo : [];
  const spaces = flattenSpaces(dayInfo, targetDate);
  for (const slot of slotPreferences) {
    const targetCourt = normalizeText(slot.court);
    const candidateSpaces = targetCourt
      ? spaces.filter((space) => courtLabel(space) === targetCourt)
      : spaces;
    for (const desiredTime of slot.times) {
      const time = findTime(times, desiredTime);
      if (!time) continue; // 时段不存在，跳过
      // 若任何场地不是 status=4，说明该时段尚未完全售出
      const allSold = candidateSpaces.length > 0 && candidateSpaces.every((space) => {
        const cell = space[String(time.id)];
        return !cell || cell.reservationStatus === 4;
      });
      if (!allSold) return false; // 还有希望
    }
  }
  return true; // 所有目标时段均已售
}

function reservationTypeForSubmit(account) {
  const value = account?.reservationType;
  return Number.isFinite(value) ? value : -1;
}

function dateWeekday(dateText) {
  const date = new Date(`${dateText}T00:00:00+08:00`);
  const day = date.getDay();
  if (!Number.isFinite(day)) return null;
  return day;
}

function predictedOrderFee(targetDate, startHour) {
  const weekday = dateWeekday(targetDate);
  const isWeekend = weekday === 0 || weekday === 6;
  if (isWeekend) return startHour >= 10 ? 35 : 25;
  return startHour >= 16 ? 25 : 15;
}

function unwrapList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.content)) return data.content;
  if (Array.isArray(data?.list)) return data.list;
  if (Array.isArray(data?.records)) return data.records;
  return [];
}

function personName(item) {
  return itemText(item, ["name", "userName", "buddyName", "realName", "nickname"]);
}

async function resolveBuddyIds(account, auth) {
  const companions = Array.isArray(account.companions) ? account.companions.map(normalizeText).filter(Boolean) : [];
  if (companions.length === 0) return { buddyIds: [], buddyDebug: [] };

  const configuredBuddyIds = Array.isArray(account.buddyIds)
    ? account.buddyIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
    : [];
  if (configuredBuddyIds.length > 0) {
    return {
      buddyIds: configuredBuddyIds,
      buddyDebug: companions.map((companion, index) => ({
        companion,
        matched: Boolean(configuredBuddyIds[index]),
        id: configuredBuddyIds[index] || null,
        source: "config",
      })),
    };
  }

  const result = await apiRequest("/api/buddies", { data: { page: -1, size: -1 } }, auth);
  const data = unwrapApiData(result, "/api/buddies");
  const buddies = unwrapList(data);
  const buddyIds = [];
  const buddyDebug = [];

  for (const companion of companions) {
    const buddy = buddies.find((item) => personName(item) === companion)
      || buddies.find((item) => personName(item).includes(companion) || companion.includes(personName(item)));
    if (!buddy) {
      buddyDebug.push({ companion, matched: false });
      continue;
    }
    const id = buddy.id ?? buddy.userId ?? buddy.buddyId;
    buddyIds.push(id);
    buddyDebug.push({ companion, matched: true, id, name: personName(buddy) });
  }

  return { buddyIds: buddyIds.filter((id) => id !== undefined && id !== null), buddyDebug };
}

// 底层组装函数（所有模式共用）
function assemblePayload(account, args, { venueSiteId, targetDate, weekStartDate, orderItems, orderPrice, buddyIds }) {
  const reservationType = reservationTypeForSubmit(account);
  const payload = {
    venueSiteId,
    reservationDate: targetDate,
    weekStartDate,
    reservationOrderJson: JSON.stringify(orderItems),
    reservationType,
    phone: normalizeText(account.phone),
    orderPin: encryptFrontendValue(jitterCoords(account.submitOrderPin || "100,100")),
  };
  if (orderPrice > 0) payload.orderPrice = orderPrice;
  payload.buddyUids = "";
  if (buddyIds.length > 0) payload.buddyIds = buddyIds.join(",");
  if (args.captchaVerification) payload.captchaVerification = args.captchaVerification;
  return payload;
}

// poll 模式：到点后轮询 day/info，直到目标场地时间段数据出现
async function pollForDayInfo(account, args, auth) {
  const venueSiteId = resolveVenueSiteId(account, args);
  const targetDate = args.date || parseConfigDate(account.dateText, account.releaseTime);
  const slotPreferences = resolveSlotPreferences(account, args);
  const pollInterval = args.dayInfoPollIntervalMs || 200;
  let attempt = 0;
  while (true) {
    attempt++;
    log(`GET /api/reservation/day/info${attempt > 1 ? ` (第${attempt}次轮询)` : ""}`);
    const result = await apiRequest("/api/reservation/day/info", {
      data: { venueSiteId, searchDate: targetDate, hasReserveInfo: 1 },
    }, auth);
    log(`day/info 完成 (+${result.elapsedMs}ms)`);
    try {
      const dayInfo = unwrapApiData(result, "/api/reservation/day/info");
      const { orderItems, debug: slotDebug, orderPrice } = buildReservationOrder(dayInfo, slotPreferences, targetDate);
      const weekStartDate = normalizeText(
        Array.isArray(dayInfo.reservationDateList) ? dayInfo.reservationDateList[0] : dayInfo.weekStartDate
      ) || targetDate;
      for (const item of slotDebug) {
        log(`场地 ${item.courtMatched}(spaceId=${item.spaceId}) × ${item.timeMatched}(timeId=${item.timeId}) ¥${item.orderFee ?? 0}`);
      }
      return { venueSiteId, targetDate, weekStartDate, orderItems, orderPrice, slotDebug };
    } catch (err) {
      if (attempt >= 50) throw new Error(`day/info 轮询超时（50次）: ${err.message}`);
      log(`day/info 暂无数据，${pollInterval}ms 后重试: ${err.message}`);
      await sleep(pollInterval);
    }
  }
}

// predict 模式：根据 timeId 每日递增规律直接计算 ID，不查 day/info
function predictItems(account, args) {
  const venueSiteId = resolveVenueSiteId(account, args);
  const anchor = account.timeIdAnchor || TIME_ID_ANCHORS[venueSiteId]
    || (() => { throw new Error(`predict 模式：未知 venueSiteId=${venueSiteId}，请在 config 中配置 timeIdAnchor`); })();
  const targetDate = args.date || parseConfigDate(account.dateText, account.releaseTime);
  if (!targetDate) throw new Error("predict 模式需要明确日期，请传 --date YYYY-MM-DD");

  // timeId 按星期几循环（服务端 7 天一个周期）
  const dowBj = new Date(targetDate + "T00:00:00+08:00").getDay(); // Sun=0,Mon=1,...,Sat=6
  const mondayBase = anchor.mondayBase
    ?? (anchor.firstTimeId - ((new Date(anchor.date + "T00:00:00+08:00").getDay() + 6) % 7) * 15);
  const firstTimeId = mondayBase + ((dowBj + 6) % 7) * 15;

  const spaceIdMap = getSpaceIdMap(venueSiteId, account.spaceIdMap);
  const slotPreferences = resolveSlotPreferences(account, args);
  const orderItems = [];
  const slotDebug = [];
  let orderPrice = 0;

  for (const slot of slotPreferences) {
    const spaceId = spaceIdMap[slot.court];
    if (!spaceId) throw new Error(`predict 模式：未知场地 "${slot.court}"，可选: ${Object.keys(spaceIdMap).join(", ")}`);
    for (const timeRange of slot.times) {
      const match = normalizeTimeRange(timeRange).match(/^(\d{1,2}):/);
      if (!match) throw new Error(`无法解析时间段: ${timeRange}`);
      const startHour = Number(match[1]);
      const timeIndex = startHour - 7; // 07:00 → index 0, 08:00 → 1, …, 21:00 → 14
      if (timeIndex < 0 || timeIndex > 14) throw new Error(`时间超出范围(07:00-21:00): ${timeRange}`);
      const timeId = firstTimeId + timeIndex;
      const price = predictedOrderFee(targetDate, startHour);
      orderPrice += price;
      orderItems.push({ spaceId, timeId });
      slotDebug.push({ court: slot.court, spaceId, time: normalizeTimeRange(timeRange), timeId, orderFee: price, dowBj, firstTimeId });
    }
  }

  return { venueSiteId, targetDate, weekStartDate: targetDate, orderItems, orderPrice, slotDebug };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.account) {
    throw new Error("请明确指定 --account account1 或 --account account2，避免误用登录态。");
  }
  if (args.timingTest && args.execute) {
    throw new Error("--timing-test 与 --execute 不能同时使用；计时测试保证不会提交订单。");
  }
  if (args.startAt && args.at) {
    throw new Error("--start-at 与 --at 不能同时使用；整点串行模式只使用 --start-at。");
  }
  if (args.startAt && args.dayInfoMode !== "predict") {
    throw new Error("--start-at 串行模式只支持 --day-info-mode predict，避免开始后查询场地。");
  }
  if (args.startAt && !args.withCaptcha && !args.captchaVerification) {
    throw new Error("--start-at 串行模式必须提供 --with-captcha 或现成的 --captcha-verification。");
  }

  const { accounts } = await readConfig();
  const account = selectAccount(accounts, args.account);
  REQUEST_VENUE_SITE_ID = resolveVenueSiteId(account, args) || 38;
  log(`请求场馆已切换为 venueSiteId=${REQUEST_VENUE_SITE_ID}（${REQUEST_VENUE_SITE_ID === 39 ? "副馆17-24号" : "主馆1-12号"}）`);

  // Parse scheduled times early to fail fast on bad format.
  let targetStartTime = 0;
  let targetSubmitTime = 0;
  let serverClockOffset = 0; // serverTime - localTime（毫秒）
  if (args.startAt) {
    targetStartTime = parseTargetTime(args.startAt) + args.startOffsetMs;
    const secsUntil = Math.round((targetStartTime - Date.now()) / 1000);
    const offsetLabel = args.startOffsetMs !== 0 ? `，整体偏移 ${args.startOffsetMs > 0 ? "+" : ""}${args.startOffsetMs}ms` : "";
    log(`目标流程开始时间: ${new Date(targetStartTime).toLocaleString("zh-CN")} ${formatClockWithMs(targetStartTime)}${offsetLabel} (${secsUntil}s 后)`);
    log("整点模式将在首轮目标前一分钟完成唯一一次服务器预校准；首轮和补抢复用结果，07:00 后不再联网校时。");
  }
  if (args.at) {
    targetSubmitTime = parseTargetTime(args.at);
    const secsUntil = Math.round((targetSubmitTime - Date.now()) / 1000);
    log(`目标提交时间: ${new Date(targetSubmitTime).toLocaleString("zh-CN")} (${secsUntil}s 后)`);
  }
  if (targetSubmitTime > 0 && targetStartTime === 0) {
    // 测量服务器时钟偏差，用于修正定时等待。
    const offset = await measureServerClockOffset();
    if (offset !== null) {
      serverClockOffset = offset;
      const sign = offset >= 0 ? "+" : "";
      log(`服务器时钟偏差: ${sign}${offset}ms（服务器${offset >= 0 ? "快" : "慢"}${Math.abs(offset)}ms，本机 ${-offset >= 0 ? "快" : "慢"}${Math.abs(offset)}ms）`);
    } else {
      log("服务器时钟偏差: 无法获取（跳过修正）");
    }
  }

  let context;
  let worker = null;
  let captchaStartedAt = 0;
  let captchaCheckedAt = 0;
  let flowStartedAt = 0;
  let flowStartedMonotonic = 0;
  let serverCalibration = null;

  try {
    // --save-auth: launch browser, save auth file, exit
    if (args.saveAuth) {
      log("启动浏览器读取登录态...");
      const launched = await launchProfile(account, args);
      context = launched.context;
      // 先导航到登录页（一次性），然后让用户自己操作
      await launched.page.goto(`${DOMAIN_URL}/venue/venue-reservation/38`, { waitUntil: "domcontentloaded" }).catch(() => {});
      log("浏览器已启动并导航到登录页，请在浏览器内完成登录。登录完成后请关闭浏览器（或关闭所有标签页），脚本会自动保存登录态。");
      // 等用户关闭浏览器。监听 context 和 page 两种 close 事件，任一触发即视为完成。
      // （某些情况下用户关闭窗口只触发 page.close 而不触发 context.close）
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        context.once("close", finish);
        launched.page.once("close", finish);
      });
      // 给浏览器一点时间清理
      await sleep(500);
      try { await context.close(); } catch {}
      context = null;
      log("检测到浏览器已关闭，重新读取持久化登录态...");
      // 用同一 userDataDir headless 重开，读取已保存到磁盘的 cookies/localStorage
      const launched2 = await launchProfile(account, { ...args, headless: true });
      try {
        const auth = await readAuthFromBrowser(launched2.context, launched2.page);
        await saveAuthToFile(account, auth);
        if (!auth.cgAuthorization && !auth.dataSixAuth && !auth.cookieCgAuthorization) {
          log("⚠️ 警告：未检测到登录态 token（cgAuthorization 等都为空），可能未成功登录，请重试。");
        } else {
          log("登录态保存完成，退出。");
        }
      } finally {
        await launched2.context.close();
      }
      return;
    }

    // Try auth from file first, fall back to browser
    let auth = await readAuthFromFile(account);
    if (auth) {
      log(`使用缓存登录态 (保存于 ${auth.savedAt || "未知时间"})`);
    } else {
      log("无缓存登录态，启动浏览器...");
      if (args.withCaptcha) {
        log("预热 ddddocr worker...");
        worker = startCaptchaWorker(account);
        worker.readyPromise
          .then(() => log("ddddocr worker 已就绪"))
          .catch(() => { worker = null; });
      }
      const launched = await launchProfile(account, args);
      context = launched.context;
      log("浏览器已启动，读取登录态...");
      auth = await readAuthFromBrowser(context, launched.page);
      log("登录态已读取，自动保存...");
      await saveAuthToFile(account, auth);
    }

    if (!auth.cgAuthorization) {
      console.warn("警告: 没读到 cgAuthorization，POST 很可能会被判定未登录。");
    }

    // Start worker if not already started (happens when auth came from file)
    if (args.withCaptcha && !worker) {
      log("预热 ddddocr worker...");
      worker = startCaptchaWorker(account);
      worker.readyPromise
        .then(() => log("ddddocr worker 已就绪"))
        .catch(() => { worker = null; });
    }

    // Wait for worker ready
    if (worker) {
      await worker.readyPromise.catch(() => { worker = null; });
    }

    const needCaptcha = args.withCaptcha && !args.captchaVerification;
    const mode = args.dayInfoMode || "predict";
    if (!["predict", "poll", "predict-no-captcha", "poll-no-captcha", "predict-late-check"].includes(mode)) {
      throw new Error(`--day-info-mode 无效值 "${mode}"，可选: predict | poll | predict-no-captcha | poll-no-captcha | predict-late-check`);
    }
    const isNoCaptchaMode = mode === "predict-no-captcha" || mode === "poll-no-captcha";
    const isPredictMode = mode === "predict" || mode === "predict-no-captcha";

    // 整点串行模式：开始前只做本地预热和本地参数计算，不发业务请求。
    // 场地/timeId 由固定映射推导；buddyIds 优先从本地私有配置读取。
    let preparedPredictItems = null;
    let preparedBuddiesResult = null;
    if (targetStartTime > 0 && isPredictMode) {
      preparedPredictItems = predictItems(account, args);
      preparedBuddiesResult = await resolveBuddyIds(account, auth);
      if (preparedBuddiesResult.buddyDebug.some((item) => item.source !== "config")) {
        throw new Error("--start-at 串行模式要求在 config.json 中预先配置 buddyIds，避免开始后查询同行人。");
      }
      log(`开始前本地准备完成：${preparedPredictItems.slotDebug.map((item) => `${item.court} ${item.time}`).join(", ")}；同行人 ID 已缓存。`);
    }

    if (targetStartTime > 0) {
      serverCalibration = await calibrateServerClockBefore(targetStartTime, "首轮服务器预校准");
      await waitWithServerCalibration(targetStartTime, serverCalibration, "首轮时间门", args.serverSafetyDelayMs);
    }
    flowStartedAt = Date.now();
    flowStartedMonotonic = performance.now();
    log(`预约流程开始（本机时间 ${formatClockWithMs(flowStartedAt)}，使用首轮预校准结果）`);

    let payload, debug;

    if (mode === "predict-late-check") {
      // ─── predict-late-check：GET+OCR 在 --at 前 N 秒，CHECK+submit 在 --at 后 ─
      // 目的：GET/OCR 在非高峰期完成（快），CHECK 在 --at 后打（一次轻量请求），submit 约 07:00:01
      const buddiesResult = await resolveBuddyIds(account, auth);
      const items = predictItems(account, args);
      for (const item of items.slotDebug) {
        log(`场地 ${item.court}(spaceId=${item.spaceId}) × ${item.time}(timeId=${item.timeId}) ¥${item.orderFee}`);
      }
      payload = assemblePayload(account, args, { ...items, buddyIds: buddiesResult.buddyIds });
      debug = { mode, targetDate: items.targetDate, weekStartDate: items.weekStartDate,
        orderPrice: items.orderPrice, slotDebug: items.slotDebug, buddyDebug: buddiesResult.buddyDebug };

      // Phase 1：GET+OCR（在 --at 前 captchaPreOcrWindowMs 毫秒）
      let getOcrResult = null;
      if (needCaptcha) {
        if (targetSubmitTime > 0) {
          const ocrStartTime = targetSubmitTime - args.captchaPreOcrWindowMs;
          const ocrDelay = Math.max(0, ocrStartTime - Date.now());
          if (ocrDelay > 0) {
            log(`验证码 GET+OCR 将在 ${ocrDelay}ms 后开始（--at 前 ${args.captchaPreOcrWindowMs}ms）`);
            await sleep(ocrDelay);
          }
        }
        getOcrResult = await resolveCaptchaGetOcr(account, args, auth, worker);
        captchaStartedAt = getOcrResult.captchaStartedAt;
        log(`GET+OCR 完成，等待 --at 后执行 CHECK（token: ${getOcrResult.backToken.slice(0, 8)}...）`);
      }

      console.log("账号:", account.name || account.accountName);
      console.log("接口:", "/api/reservation/order/submit");
      console.log(`调试信息 (CHECK 将在 --at 后执行，GET+OCR 已在 --at 前 ${args.captchaPreOcrWindowMs}ms 完成):`);
      console.log(JSON.stringify(debug, null, 2));
      if (!args.execute && !args.timingTest) {
        console.log("DRY-RUN: 未提交。加 --execute 才会真正 POST。");
        return;
      }

      // 等待 --at
      if (targetSubmitTime > 0) {
        const waitMs = targetSubmitTime - serverClockOffset - Date.now();
        if (waitMs > 0) {
          log(`等待目标时间: ${waitMs}ms`);
          await sleep(waitMs);
        } else {
          log(`目标时间已过 (${-waitMs}ms 前)，立即 CHECK`);
        }
      }

      // Phase 2：CHECK（在 --at 时刻）
      if (needCaptcha && getOcrResult) {
        const checkResult = await resolveCaptchaCheckOnly(auth, getOcrResult);
        captchaCheckedAt = checkResult.captchaCheckedAt;
        payload.captchaVerification = checkResult.captchaVerification;
        payload.captchaToken = checkResult.captchaToken;
        debug.captchaDebug = { ...getOcrResult, checkMs: checkResult.checkMs };
      }

    } else if (!isNoCaptchaMode) {
      // ─── predict / poll：--at 前预先解验证码 ───────────────────────────────
      // captchaPreWindowMs > 0 → 在 --at 前 N ms 开始解（默认 8000ms）
      // captchaPreWindowMs = 0 → 在 --at 时刻才开始解（适合 07:00 边界场景）
      let captchaStartDelay = 0;
      if (targetSubmitTime > 0 && needCaptcha) {
        const captchaStartTime = targetSubmitTime - args.captchaPreWindowMs;
        captchaStartDelay = Math.max(0, captchaStartTime - Date.now());
        if (captchaStartDelay > 0) {
          const label = args.captchaPreWindowMs > 0
            ? `--at 前 ${args.captchaPreWindowMs}ms`
            : `--at 时刻（captcha-pre-window-ms=0）`;
          log(`验证码将在 ${captchaStartDelay}ms 后开始解算（${label}）`);
        }
      }

      const delayedCaptcha = needCaptcha
        ? (async () => {
            if (captchaStartDelay > 0) await sleep(captchaStartDelay);
            return resolveCaptchaVerification(account, args, auth, worker);
          })()
        : Promise.resolve(null);

      // captcha（延迟）+ buddies 并行；不查 day/info
      const [captchaResult, buddiesResult] = await Promise.all([
        delayedCaptcha,
        preparedBuddiesResult || resolveBuddyIds(account, auth),
      ]);
      if (captchaResult) {
        captchaStartedAt = captchaResult.captchaStartedAt;
        captchaCheckedAt = captchaResult.captchaCheckedAt;
      }

      if (isPredictMode) {
        // predict：规则推断 ID，payload 在 --at 前就准备好
        const items = preparedPredictItems || predictItems(account, args);
        for (const item of items.slotDebug) {
          log(`场地 ${item.court}(spaceId=${item.spaceId}) × ${item.time}(timeId=${item.timeId}) ¥${item.orderFee}`);
        }
        payload = assemblePayload(account, args, { ...items, buddyIds: buddiesResult.buddyIds });
        debug = { mode, targetDate: items.targetDate, weekStartDate: items.weekStartDate,
          orderPrice: items.orderPrice, slotDebug: items.slotDebug, buddyDebug: buddiesResult.buddyDebug };
        if (captchaResult) {
          payload.captchaVerification = captchaResult.captchaVerification;
          payload.captchaToken = captchaResult.captchaToken;
          debug.captchaDebug = captchaResult.debug;
        }
        console.log("账号:", account.name || account.accountName);
        console.log("接口:", "/api/reservation/order/submit");
        console.log("调试信息:");
        console.log(JSON.stringify(debug, null, 2));
        console.log("payload:");
        console.log(JSON.stringify(payload, null, 2));
        if (!args.execute && !args.timingTest) {
          console.log("DRY-RUN: 未提交。确认 payload 后加 --execute 才会真正 POST。");
          return;
        }
      } else {
        // poll：buddies 和 captcha 准备好了，等 --at 后再拉 day/info
        if (!args.execute && !args.timingTest) {
          console.log("DRY-RUN (poll): 到时间后将轮询 day/info 并提交。加 --execute 才会真正执行。");
          return;
        }
      }

      // 等待 --at
      if (targetSubmitTime > 0) {
        // serverClockOffset = serverTime - localTime
        // 要等到 serverTime >= targetSubmitTime，即 localTime >= targetSubmitTime - serverClockOffset
        const waitMs = targetSubmitTime - serverClockOffset - Date.now();
        if (waitMs > 0) {
          log(`等待目标时间: ${waitMs}ms`);
          await sleep(waitMs);
        } else {
          log(`目标时间已过 (${-waitMs}ms 前)，立即提交`);
        }
      }

      if (!isPredictMode) {
        // poll：到点后轮询 day/info
        const items = await pollForDayInfo(account, args, auth);
        payload = assemblePayload(account, args, { ...items, buddyIds: buddiesResult.buddyIds });
        debug = { mode, targetDate: items.targetDate, weekStartDate: items.weekStartDate,
          orderPrice: items.orderPrice, slotDebug: items.slotDebug, buddyDebug: buddiesResult.buddyDebug };
        if (captchaResult) {
          payload.captchaVerification = captchaResult.captchaVerification;
          payload.captchaToken = captchaResult.captchaToken;
          debug.captchaDebug = captchaResult.debug;
        }
        console.log("payload:");
        console.log(JSON.stringify(payload, null, 2));
      }

    } else {
      // ─── predict-no-captcha / poll-no-captcha：--at 后才解验证码 ──────────
      // 验证码在 07:00 之后才取，避免跨天 token 失效

      // buddies 立即拉取
      const buddiesResult = preparedBuddiesResult || await resolveBuddyIds(account, auth);
      const buddyIds = buddiesResult.buddyIds;

      if (isPredictMode) {
        // predict-no-captcha：规则推断 ID，--at 前就可以组装 payload（无 captchaVerification）
        const items = preparedPredictItems || predictItems(account, args);
        for (const item of items.slotDebug) {
          log(`场地 ${item.court}(spaceId=${item.spaceId}) × ${item.time}(timeId=${item.timeId}) ¥${item.orderFee}`);
        }
        payload = assemblePayload(account, args, { ...items, buddyIds });
        debug = { mode, targetDate: items.targetDate, weekStartDate: items.weekStartDate,
          orderPrice: items.orderPrice, slotDebug: items.slotDebug, buddyDebug: buddiesResult.buddyDebug };
        console.log("账号:", account.name || account.accountName);
        console.log("接口:", "/api/reservation/order/submit");
        console.log("调试信息 (captchaVerification 将在 --at 后填入):");
        console.log(JSON.stringify(debug, null, 2));
        console.log("payload (captchaVerification 将在 --at 后填入):");
        console.log(JSON.stringify(payload, null, 2));
        if (!args.execute && !args.timingTest) {
          console.log("DRY-RUN: 未提交。加 --execute 才会真正 POST。");
          return;
        }
      } else {
        if (!args.execute && !args.timingTest) {
          console.log("DRY-RUN (poll-no-captcha): 到时间后并行拉验证码和场地信息。加 --execute 才会真正执行。");
          return;
        }
      }

      // 等待 --at
      if (targetSubmitTime > 0) {
        // serverClockOffset = serverTime - localTime
        // 要等到 serverTime >= targetSubmitTime，即 localTime >= targetSubmitTime - serverClockOffset
        const waitMs = targetSubmitTime - serverClockOffset - Date.now();
        if (waitMs > 0) {
          log(`等待目标时间: ${waitMs}ms`);
          await sleep(waitMs);
        } else {
          log(`目标时间已过 (${-waitMs}ms 前)，立即提交`);
        }
      }

      if (isPredictMode) {
        // predict-no-captcha：--at 后解验证码，payload 已准备好
        if (needCaptcha) {
          const cap = await resolveCaptchaVerification(account, args, auth, worker);
          captchaStartedAt = cap.captchaStartedAt;
          captchaCheckedAt = cap.captchaCheckedAt;
          payload.captchaVerification = cap.captchaVerification;
          payload.captchaToken = cap.captchaToken;
          if (debug) debug.captchaDebug = cap.debug;
        }
      } else {
        // poll-no-captcha：--at 后先轮询 day/info，拿到后立即解验证码（同一 session，避免并发竞态）
        const items = await pollForDayInfo(account, args, auth);
        const cap = needCaptcha ? await resolveCaptchaVerification(account, args, auth, worker) : null;
        if (cap) {
          captchaStartedAt = cap.captchaStartedAt;
          captchaCheckedAt = cap.captchaCheckedAt;
        }
        payload = assemblePayload(account, args, { ...items, buddyIds });
        debug = { mode, targetDate: items.targetDate, weekStartDate: items.weekStartDate,
          orderPrice: items.orderPrice, slotDebug: items.slotDebug, buddyDebug: buddiesResult.buddyDebug };
        if (cap) {
          payload.captchaVerification = cap.captchaVerification;
          payload.captchaToken = cap.captchaToken;
          debug.captchaDebug = cap.debug;
        }
        console.log("payload:");
        console.log(JSON.stringify(payload, null, 2));
      }
    }

    // 提交循环（三种模式共用）
    const submitAttempts = args.submitAttempts;
    let result;
    for (let submitAttempt = 1; submitAttempt <= submitAttempts; submitAttempt++) {
      // Timing gate (naturally 0ms when --at provides sufficient lead time)
      let waitUntil = 0;
      if (captchaStartedAt && args.minCaptchaAgeMs > 0) {
        waitUntil = Math.max(waitUntil, captchaStartedAt + args.minCaptchaAgeMs);
      }
      if (captchaCheckedAt && args.minCaptchaCheckAgeMs > 0) {
        waitUntil = Math.max(waitUntil, captchaCheckedAt + args.minCaptchaCheckAgeMs);
      }
      const wallClockWaitMs = Math.max(0, waitUntil - Date.now());
      const monotonicElapsedMs = flowStartedMonotonic ? performance.now() - flowStartedMonotonic : 0;
      const flowWaitMs = flowStartedMonotonic && args.minFlowDurationMs > 0
        ? Math.max(0, args.minFlowDurationMs - monotonicElapsedMs)
        : 0;
      const waitMs = Math.max(wallClockWaitMs, flowWaitMs);
      if (waitMs > 0) {
        log(`等待安全提交门槛: ${waitMs}ms（最短流程 ${args.minFlowDurationMs}ms）`);
        await sleep(waitMs);
      }

      const flowElapsedBeforeSubmit = flowStartedMonotonic
        ? Math.round(performance.now() - flowStartedMonotonic)
        : (flowStartedAt ? Date.now() - flowStartedAt : 0);
      log(`已到提交门槛：流程耗时 ${flowElapsedBeforeSubmit}ms`);
      if (args.timingTest) {
        console.log(`TIMING-TEST: 已完整走到提交前，流程耗时 ${flowElapsedBeforeSubmit}ms；未发送订单请求。`);
        return;
      }

      log("POST /api/reservation/order/submit");
      result = await apiRequest("/api/reservation/order/submit", {
        method: "POST",
        data: payload,
      }, auth);
      log(`submit 完成: http=${result.status} (+${result.elapsedMs}ms)`);
      if (flowStartedMonotonic || flowStartedAt) {
        const responseElapsedMs = flowStartedMonotonic
          ? Math.round(performance.now() - flowStartedMonotonic)
          : Date.now() - flowStartedAt;
        log(`订单响应时总流程耗时: ${responseElapsedMs}ms`);
      }
      console.log(result.body ? JSON.stringify(result.body, null, 2) : result.text);

      if (!args.withCaptcha || result?.body?.code !== 250) break;
      if (!/验证码/.test(result?.body?.message || "")) break; // 非验证码原因的 250 不重试
      if (submitAttempt >= submitAttempts) break;

      log(`验证码非法校验（第 ${submitAttempt} 次），重新解验证码，增加等待时间...`);
      args.minCaptchaCheckAgeMs += 300;
      const captcha = await resolveCaptchaVerification(account, args, auth, worker);
      payload.captchaVerification = captcha.captchaVerification;
      payload.captchaToken = captcha.captchaToken;
      if (debug) debug.captchaDebug = captcha.debug;
      captchaStartedAt = captcha.captchaStartedAt;
      captchaCheckedAt = captcha.captchaCheckedAt;
    }

    // ─── 捡漏重试：首次失败后在锁单超时窗口内轮询 day/info ────────────────────
    if (args.retryOnFail && result?.body?.code !== 200
        && !/验证码/.test(result?.body?.message || "")) {
      const retryBaseTime = targetStartTime > 0
        ? targetStartTime
        : (targetSubmitTime > 0 ? targetSubmitTime - serverClockOffset : Date.now());
      const retryDeadline = retryBaseTime + args.retryWindowMs;
      const retryVenueSiteId = payload.venueSiteId;
      const retryTargetDate = payload.reservationDate;
      const retrySlotPrefs = resolveRetrySlotPreferences(account, args);
      const retryBuddyIds = payload.buddyIds ? payload.buddyIds.split(",").filter(Boolean) : [];
      const atTime = retryBaseTime;
      log(`\n首次提交失败（${result?.body?.message || "未知原因"}），进入捡漏模式（最长至 ${new Date(atTime + args.retryWindowMs).toLocaleTimeString("zh-CN", { hour12: false })}）...`);
      const retryTimesDesc = retrySlotPrefs.flatMap((s) => s.times).join(", ");
      log(`捡漏目标时段: ${retryTimesDesc}（${args.retryRequireConsecutiveTwo ? "须同场连续两小时，不降级" : `最多提交 ${args.retryMaxSlots} 个`}）`);

      // 等到开始时间 + retryCaptchaDelayMs 再解验证码（按服务器时钟校准）。
      const captchaStartAt = atTime + args.retryCaptchaDelayMs;
      await waitWithServerCalibration(captchaStartAt, serverCalibration, "补抢验证码时间门", 200);

      // 开始解验证码（异步，后台进行）
      let captchaPromise = needCaptcha
        ? resolveCaptchaVerification(account, args, auth, worker).catch((e) => { log(`验证码解析失败: ${e.message}`); return null; })
        : null;

      // 等到开始时间 + retryPollDelayMs 再开始轮询（按服务器时钟校准）。
      const pollStartAt = atTime + args.retryPollDelayMs;
      await waitWithServerCalibration(pollStartAt, serverCalibration, "补抢轮询时间门", 200);

      let retrySuccess = false;
      let retrySubmitCount = 0;
      let firstRetryPoll = true;
      while (Date.now() < retryDeadline) {
        if (!firstRetryPoll) await sleep(args.retryPollMs);
        firstRetryPoll = false;
        if (Date.now() >= retryDeadline) break;

        const secsLeft = Math.ceil((retryDeadline - Date.now()) / 1000);
        log(`GET /api/reservation/day/info (捡漏轮询，剩余 ${secsLeft}s)`);
        let dayInfo;
        try {
          const r = await apiRequest("/api/reservation/day/info", {
            data: { venueSiteId: retryVenueSiteId, searchDate: retryTargetDate, hasReserveInfo: 1 },
          }, auth);
          dayInfo = unwrapApiData(r, "/api/reservation/day/info");
        } catch (e) { log(`day/info 失败: ${e.message}`); continue; }

        const allAvailable = findAvailableRetryItems(dayInfo, retrySlotPrefs, retryTargetDate);
        let availableItems = args.retryRequireConsecutiveTwo || args.retryPreferConsecutiveTwo
          ? selectPreferredConsecutiveTwo(allAvailable, !args.retryRequireConsecutiveTwo)
          : (args.retryRequireAll
            ? selectCompleteRetryCourt(allAvailable, retrySlotPrefs)
            : selectBestRetryItems(allAvailable, args.retryMaxSlots));
        if (!args.retryRequireConsecutiveTwo && args.retryPreferConsecutiveTwo && availableItems.length === 1) {
          log(`没有任意同场连续两小时，降级为单时段：${availableItems[0].spaceName} ${availableItems[0].timeRange}`);
        }
        const requiredSlotCount = retrySlotPrefs.reduce((sum, slot) => sum + slot.times.length, 0);
        if (!args.retryRequireConsecutiveTwo && !args.retryPreferConsecutiveTwo && args.retryRequireAll && availableItems.length < requiredSlotCount) {
          if (args.retryFallbackSingle && allAvailable.length > 0) {
            availableItems = [allAvailable[0]];
            log(`没有同场连续 ${requiredSlotCount} 个时段，降级为单时段：${availableItems[0].spaceName} ${availableItems[0].timeRange}`);
          } else {
            log(`目标时段尚未全部释放（${availableItems.length}/${requiredSlotCount}），继续等待...`);
            continue;
          }
        }
        if (availableItems.length === 0) {
          if (allTargetSlotsSoldOut(dayInfo, retrySlotPrefs, retryTargetDate)) {
            log("所有目标时段均已售出（status=4），停止捡漏");
            break;
          }
          log(args.retryRequireConsecutiveTwo
            ? "暂无任意同场连续两小时，继续等待..."
            : "暂无可用场地（status≠1），继续等待...");
          continue;
        }

        log(`发现可用 ${allAvailable.length} 个时段，选择 ${availableItems.length} 个: ${availableItems.map((i) => `${i.spaceName} ${i.timeRange}`).join(", ")}`);

        // 等验证码（若已就绪直接用，否则等待）
        let retryCap = captchaPromise ? await captchaPromise : null;
        if (needCaptcha && !retryCap) {
          log("验证码未就绪，重新解...");
          captchaPromise = resolveCaptchaVerification(account, args, auth, worker).catch(() => null);
          retryCap = await captchaPromise;
          if (!retryCap) { log("验证码再次失败，跳过本轮"); continue; }
        }

        const retryWeekStart = normalizeText(
          Array.isArray(dayInfo.reservationDateList) ? dayInfo.reservationDateList[0] : dayInfo.weekStartDate
        ) || retryTargetDate;
        const retryOrderItems = availableItems.map(({ spaceId, timeId }) => ({ spaceId, timeId }));
        const retryOrderPrice = availableItems.reduce((s, i) => s + i.orderFee, 0);
        const retryPayload = assemblePayload(account, args, {
          venueSiteId: retryVenueSiteId, targetDate: retryTargetDate, weekStartDate: retryWeekStart,
          orderItems: retryOrderItems, orderPrice: retryOrderPrice, buddyIds: retryBuddyIds,
        });
        if (retryCap) {
          retryPayload.captchaVerification = retryCap.captchaVerification;
          retryPayload.captchaToken = retryCap.captchaToken;
        }

        log("POST /api/reservation/order/submit (捡漏)");
        retrySubmitCount += 1;
        const retryResult = await apiRequest("/api/reservation/order/submit", { method: "POST", data: retryPayload }, auth);
        log(`捡漏 submit: http=${retryResult.status} (+${retryResult.elapsedMs}ms)`);
        console.log(retryResult.body ? JSON.stringify(retryResult.body, null, 2) : retryResult.text);

        if (retryResult.body?.code === 200) { retrySuccess = true; break; }
        if (retrySubmitCount >= args.retrySubmitAttempts) {
          log(`补抢订单请求已达到上限 ${args.retrySubmitAttempts} 次，停止补抢。`);
          break;
        }
        // 无论何种失败，captcha 已消耗，立即开始解新的（后台并行）
        if (needCaptcha) {
          captchaPromise = resolveCaptchaVerification(account, args, auth, worker).catch(() => null);
        }
        if (/未支付/.test(retryResult.body?.message || "")) {
          log("存在未支付订单，继续等待...");
        }
      }
      if (!retrySuccess) log(`捡漏窗口结束，未能抢到场地`);
    }

  } finally {
    worker?.close();
    if (context) await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
