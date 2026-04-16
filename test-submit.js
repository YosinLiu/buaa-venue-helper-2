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
const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const DOMAIN_URL = "https://cgyy.buaa.edu.cn";
const SERVER_URL = `${DOMAIN_URL}/venue-server`;
const DEFAULT_APP_KEY = "8fceb735082b5a529312040b58ea780b";
const DEFAULT_SIGN_SECRET = "c640ca392cd45fb3a55b00a63a86c618";
const DEFAULT_AES_KEY = "c1h2i5n6g2o2k4a7";
const DEFAULT_AES_IV = "C2H3I4N5G2O3K1E4";
const CAPTCHA_TYPE_CLICK_WORD = "clickWord";
const CAPTCHA_SUCCESS_CODE = "0000";

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

// predict 模式 timeId 锚点（每个 venue 独立递增，每天 +15）
const TIME_ID_ANCHORS = {
  38: { date: "2026-04-14", firstTimeId: 8703 },
  39: { date: "2026-04-14", firstTimeId: 9083 },
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
  node test-submit.js --account zxy
  node test-submit.js --account lys --date 2026-04-15
  node test-submit.js --account zxy --execute

默认只打印将要 POST 的 payload，不会提交。
只有加 --execute 才会真正 POST 到 /api/reservation/order/submit。

可选参数:
  --account NAME              账号名，必填，多账号时例如 zxy / lys
  --date YYYY-MM-DD           预约日期；默认从 config.json 的 dateText 推导
  --court NAME                覆盖 config 里的场地，例如 6号
  --times A,B                 覆盖 config 里的时间，例如 07:00-08:00,19:00-20:00
  --with-captcha              提交前获取点选验证码，用 DDDDOCR 校验并填入 captchaVerification
  --captcha-attempts N        验证码识别/校验最多尝试次数，默认 3
  --captcha-offset-px N       [测试用] OCR 识别后将每个点偏移 +N 像素，默认 0（不偏移）
  --min-captcha-age-ms N      验证码从 get 到 submit 的最小间隔，默认 1300ms
  --min-captcha-check-age-ms N  验证码 check 完成到 submit 的最小间隔，默认 700ms
  --captcha-verification VAL  手动填入验证码 check 返回的 captchaVerification
  --payload FILE              直接读取 JSON payload，不自动查 day/info 和 buddies
  --execute                   真的提交；不加时仅 dry-run
  --headless                  无头打开账号 profile 读取登录态
  --save-auth                 启动浏览器读取登录态并保存到文件后退出（首次使用或登录过期时运行）
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
    captchaVerification: "",
    payloadFile: "",
    venueSiteId: 0,
    execute: false,
    headless: false,
    saveAuth: false,
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
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--with-captcha") args.withCaptcha = true;
    else if (arg === "--save-auth") args.saveAuth = true;
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
    data.nocache = timestamp;
  }
  const cleanData = compactScalarData(data);
  const sign = signRequest(timestamp, apiPath, cleanData);
  const headers = {
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/x-www-form-urlencoded",
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
      orderItems.push({
        spaceId: space.id,
        timeId: time.id,
        venueSpaceGroupId: space.venueSpaceGroupId || null,
      });
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

function reservationTypeForSubmit(account) {
  const value = Number(account.reservationType ?? -1);
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
    orderPin: encryptFrontendValue(account.submitOrderPin || "100,100"),
  };
  if (orderPrice > 0) payload.orderPrice = orderPrice;
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

  const diffDays = Math.round(
    (new Date(targetDate + "T00:00:00").getTime() - new Date(anchor.date + "T00:00:00").getTime()) / 86400000
  );
  const firstTimeId = anchor.firstTimeId + diffDays * 15;

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
      orderItems.push({ spaceId, timeId, venueSpaceGroupId: null });
      slotDebug.push({ court: slot.court, spaceId, time: normalizeTimeRange(timeRange), timeId, orderFee: price, diffDays, firstTimeId });
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
    throw new Error("请明确指定 --account zxy 或 --account lys，避免误用登录态。");
  }

  const { accounts } = await readConfig();
  const account = selectAccount(accounts, args.account);

  // Parse --at early to fail fast on bad format
  let targetSubmitTime = 0;
  let serverClockOffset = 0; // serverTime - localTime（毫秒）
  if (args.at) {
    targetSubmitTime = parseTargetTime(args.at);
    const secsUntil = Math.round((targetSubmitTime - Date.now()) / 1000);
    log(`目标提交时间: ${new Date(targetSubmitTime).toLocaleString("zh-CN")} (${secsUntil}s 后)`);
    // 测量服务器时钟偏差，用于修正 --at 等待时间
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

  try {
    // --save-auth: launch browser, save auth file, exit
    if (args.saveAuth) {
      log("启动浏览器读取登录态...");
      const launched = await launchProfile(account, args);
      context = launched.context;
      log("浏览器已启动，读取登录态...");
      const auth = await readAuthFromBrowser(context, launched.page);
      await saveAuthToFile(account, auth);
      log("登录态保存完成，退出。");
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
      if (!args.execute) {
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
        resolveBuddyIds(account, auth),
      ]);
      if (captchaResult) {
        captchaStartedAt = captchaResult.captchaStartedAt;
        captchaCheckedAt = captchaResult.captchaCheckedAt;
      }

      if (isPredictMode) {
        // predict：规则推断 ID，payload 在 --at 前就准备好
        const items = predictItems(account, args);
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
        if (!args.execute) {
          console.log("DRY-RUN: 未提交。确认 payload 后加 --execute 才会真正 POST。");
          return;
        }
      } else {
        // poll：buddies 和 captcha 准备好了，等 --at 后再拉 day/info
        if (!args.execute) {
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
      const buddiesResult = await resolveBuddyIds(account, auth);
      const buddyIds = buddiesResult.buddyIds;

      if (isPredictMode) {
        // predict-no-captcha：规则推断 ID，--at 前就可以组装 payload（无 captchaVerification）
        const items = predictItems(account, args);
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
        if (!args.execute) {
          console.log("DRY-RUN: 未提交。加 --execute 才会真正 POST。");
          return;
        }
      } else {
        if (!args.execute) {
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
    const submitAttempts = args.withCaptcha ? args.captchaAttempts : 1;
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
      const waitMs = Math.max(0, waitUntil - Date.now());
      if (waitMs > 0) {
        log(`等待验证码 token 稳定: ${waitMs}ms`);
        await sleep(waitMs);
      }

      log("POST /api/reservation/order/submit");
      result = await apiRequest("/api/reservation/order/submit", {
        method: "POST",
        data: payload,
      }, auth);
      log(`submit 完成: http=${result.status} (+${result.elapsedMs}ms)`);
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
  } finally {
    worker?.close();
    if (context) await context.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
