import fs from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { chromium } from "playwright";
import OpenAI from "openai";

// 用于给并发标签页的日志自动加前缀（如 [T1] [T2] [T3]）
const workerStorage = new AsyncLocalStorage();

const CONFIG_PATH = path.resolve(process.cwd(), "config.json");
const execFileAsync = promisify(execFile);
const MAC_BROWSER_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];
const LINUX_BROWSER_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/microsoft-edge",
  "/usr/bin/microsoft-edge-stable",
];
const DEFAULT_VENUE_URL_38 = "https://cgyy.buaa.edu.cn/venue/venue-reservation/38";
const DEFAULT_VENUE_URL_39 = "https://cgyy.buaa.edu.cn/venue/venue-reservation/39";
const PROFILE_BROWSER_KEYWORDS = [
  "Google Chrome for Testing",
  "Google Chrome",
  "Chromium",
  "Microsoft Edge",
  "msedge",
];

function resolveCaptchaWorkerCount(config = {}) {
  const configured = Number(config.captchaDdddocrWorkerCount);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.floor(configured));
  }

  const accounts = Array.isArray(config.accounts)
    ? config.accounts.filter((account) => account.enabled !== false)
    : [];
  if (accounts.length > 0) {
    const totalConcurrency = accounts.reduce((sum, account) => {
      const value = Number(account.concurrency ?? config.concurrency ?? 1);
      return sum + (Number.isFinite(value) && value > 0 ? Math.floor(value) : 1);
    }, 0);
    return Math.min(Math.max(totalConcurrency, 1), 4);
  }

  const concurrency = Math.max(1, Number(config.concurrency) || 1);
  return Math.min(concurrency, 2);
}

function coerceBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const text = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
  }
  return fallback;
}

function resolveDdddocrRuntime(config = {}) {
  const useGpu = coerceBoolean(config.captchaDdddocrUseGpu, false);
  const deviceId = Number(config.captchaDdddocrGpuDeviceId ?? 0);
  return {
    useGpu,
    deviceId: Number.isFinite(deviceId) ? Math.max(0, Math.floor(deviceId)) : 0,
  };
}

function buildDdddocrEnv(config = {}) {
  const runtime = resolveDdddocrRuntime(config);
  return {
    ...process.env,
    DDDDOCR_USE_GPU: runtime.useGpu ? "1" : "0",
    DDDDOCR_DEVICE_ID: String(runtime.deviceId),
  };
}

function formatDdddocrRuntime(config = {}) {
  const runtime = resolveDdddocrRuntime(config);
  return runtime.useGpu ? `GPU device=${runtime.deviceId}` : "CPU";
}

class DdddocrWorkerPool {
  constructor(config = {}) {
    this.config = config;
    this.pythonBin = config.pythonBin || "python3";
    this.scriptPath = path.resolve(process.cwd(), "solve_captcha_worker.py");
    this.size = resolveCaptchaWorkerCount(config);
    this.runtimeLabel = formatDdddocrRuntime(config);
    this.workers = [];
    this.started = false;
    this.closed = false;
    this.nextRequestId = 1;
  }

  async start() {
    if (this.started || this.closed) return;
    this.started = true;
    log(`正在预热 ddddocr 常驻 worker: ${this.size} 个（${this.runtimeLabel}）。`);
    this.workers = Array.from({ length: this.size }, (_, index) => this.#spawnWorker(index + 1));
    await Promise.all(this.workers.map((worker) => worker.readyPromise));
    log(`ddddocr 常驻 worker 已预热完成: ${this.workers.length} 个（${this.runtimeLabel}）。`);
    await this.logResourceUsage("启动后").catch((error) => {
      log(`读取 ddddocr worker 资源占用失败: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  #spawnWorker(index) {
    const child = spawn(this.pythonBin, [this.scriptPath], {
      env: buildDdddocrEnv(this.config),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const worker = {
      index,
      child,
      buffer: "",
      busy: 0,
      ready: false,
      pending: new Map(),
      readyPromise: null,
      resolveReady: null,
      rejectReady: null,
    };

    worker.readyPromise = new Promise((resolve, reject) => {
      worker.resolveReady = resolve;
      worker.rejectReady = reject;
    });

    child.stdout.on("data", (chunk) => {
      worker.buffer += chunk.toString("utf8");
      let newlineIndex = worker.buffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const line = worker.buffer.slice(0, newlineIndex).trim();
        worker.buffer = worker.buffer.slice(newlineIndex + 1);
        if (line) {
          this.#handleWorkerMessage(worker, line);
        }
        newlineIndex = worker.buffer.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text) {
        log(`[OCR-W${worker.index}] ${text}`);
      }
    });

    const handleFailure = (error) => {
      if (!worker.ready) {
        worker.rejectReady?.(error);
      }
      for (const { reject } of worker.pending.values()) {
        reject(error);
      }
      worker.pending.clear();
      worker.busy = 0;
    };

    child.on("error", (error) => {
      handleFailure(error);
    });

    child.on("exit", (code, signal) => {
      if (this.closed) return;
      handleFailure(new Error(`ddddocr worker #${worker.index} 已退出 (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    });

    return worker;
  }

  #handleWorkerMessage(worker, line) {
    let payload;
    try {
      payload = JSON.parse(line);
    } catch (error) {
      log(`[OCR-W${worker.index}] 无法解析响应: ${line.slice(0, 200)}`);
      return;
    }

    if (payload.type === "ready") {
      worker.ready = true;
      worker.resolveReady?.();
      return;
    }

    const requestId = String(payload.id || "");
    const pending = worker.pending.get(requestId);
    if (!pending) {
      return;
    }

    worker.pending.delete(requestId);
    worker.busy = Math.max(0, worker.busy - 1);

    if (payload.error) {
      pending.reject(new Error(payload.error));
      return;
    }

    pending.resolve(payload);
  }

  async solve(imageBuffer, targets, mode) {
    if (!this.started) {
      await this.start();
    }
    if (this.closed) {
      throw new Error("ddddocr worker pool 已关闭");
    }

    const readyWorkers = this.workers.filter((worker) => worker.ready);
    if (readyWorkers.length === 0) {
      throw new Error("没有可用的 ddddocr worker");
    }

    readyWorkers.sort((a, b) => a.busy - b.busy || a.index - b.index);
    const worker = readyWorkers[0];
    const requestId = String(this.nextRequestId++);

    return new Promise((resolve, reject) => {
      worker.pending.set(requestId, { resolve, reject });
      worker.busy += 1;

      const payload = JSON.stringify({
        id: requestId,
        mode,
        targets,
        image_base64: imageBuffer.toString("base64"),
      });

      worker.child.stdin.write(`${payload}\n`, (error) => {
        if (!error) return;
        worker.pending.delete(requestId);
        worker.busy = Math.max(0, worker.busy - 1);
        reject(error);
      });
    });
  }

  async close() {
    this.closed = true;
    await Promise.all(
      this.workers.map(async (worker) => {
        for (const { reject } of worker.pending.values()) {
          reject(new Error("ddddocr worker pool 正在关闭"));
        }
        worker.pending.clear();
        worker.busy = 0;
        worker.child.stdin.end();
        worker.child.kill("SIGTERM");
      }),
    );
  }

  async logResourceUsage(label = "") {
    const rows = await Promise.all(
      this.workers.map(async (worker) => {
        const pid = worker.child.pid;
        const memory = pid ? await readProcessMemoryUsage(pid) : null;
        return { worker, pid, memory };
      }),
    );
    const totalRssMb = rows.reduce((sum, row) => sum + (row.memory?.rssMb || 0), 0);
    const details = rows.map(({ worker, pid, memory }) => {
      const rssText = memory ? `${memory.rssMb.toFixed(1)}MiB RSS` : "RSS未知";
      const vmText = memory ? `${memory.vmSizeMb.toFixed(1)}MiB VM` : "VM未知";
      return `W${worker.index} pid=${pid || "?"} ${rssText} ${vmText}`;
    });
    log(`ddddocr worker 资源占用${label ? `（${label}）` : ""}: ${details.join("；")}；总 RSS=${totalRssMb.toFixed(1)}MiB`);

    const gpuRows = await readNvidiaSmiProcessUsage(rows.map((row) => row.pid).filter(Boolean));
    if (gpuRows.length > 0) {
      log(`ddddocr worker GPU 显存: ${gpuRows.map((row) => `pid=${row.pid} ${row.usedMemoryMb}MiB`).join("；")}`);
    }
  }
}

async function readProcessMemoryUsage(pid) {
  if (!pid || process.platform !== "linux") return null;
  try {
    const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
    const readKb = (key) => {
      const match = status.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
      return match ? Number(match[1]) : 0;
    };
    return {
      rssMb: readKb("VmRSS") / 1024,
      vmSizeMb: readKb("VmSize") / 1024,
    };
  } catch {
    return null;
  }
}

async function readNvidiaSmiProcessUsage(pids) {
  if (!Array.isArray(pids) || pids.length === 0) return [];
  try {
    const { stdout } = await execFileAsync("nvidia-smi", [
      "--query-compute-apps=pid,used_memory",
      "--format=csv,noheader,nounits",
    ], { timeout: 3000 });
    const wanted = new Set(pids.map(String));
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [pid, usedMemoryMb] = line.split(",").map((part) => part.trim());
        return { pid, usedMemoryMb };
      })
      .filter((row) => wanted.has(row.pid));
  } catch {
    return [];
  }
}

function parseArgs(argv) {
  const args = {
    login: false,
    inspect: false,
    headless: undefined,
    help: false,
    account: "",
    ocrCheck: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--login") args.login = true;
    else if (arg === "--inspect") args.inspect = true;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--ocr-check") args.ocrCheck = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--account") {
      args.account = normalizeText(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith("--account=")) {
      args.account = normalizeText(arg.slice("--account=".length));
    }
  }

  return args;
}

function printHelp() {
  console.log(`
用法:
  npm run login
  npm run reserve
  npm run inspect

可选参数:
  --headless   无头模式运行
  --inspect    只做页面探测，不执行预约
  --login      打开浏览器并等待你手动登录，保存登录态
  --account    多账号模式下指定账号名，例如 --account lys
  --ocr-check  只预热 OCR worker 并输出资源占用，不打开浏览器
  `);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomIntBetween(min, max) {
  const minInt = Math.round(min);
  const maxInt = Math.round(max);
  if (minInt >= maxInt) return minInt;
  return Math.floor(Math.random() * (maxInt - minInt + 1)) + minInt;
}

function getConfigDelayMs(config = {}, minKey, maxKey, fallbackMin = 0, fallbackMax = fallbackMin) {
  const rawMin = Number(config[minKey]);
  const rawMax = Number(config[maxKey]);
  const hasMin = Number.isFinite(rawMin) && rawMin >= 0;
  const hasMax = Number.isFinite(rawMax) && rawMax >= 0;

  let min = hasMin ? rawMin : fallbackMin;
  let max = hasMax ? rawMax : fallbackMax;

  if (!hasMin && hasMax) min = max;
  if (!hasMax && hasMin) max = min;
  if (min > max) [min, max] = [max, min];

  return randomIntBetween(min, max);
}

function getCaptchaClickDelayMs(config = {}) {
  const fixed = Number(config.captchaClickIntervalMs);
  const rawMin = Number(config.captchaClickIntervalMinMs);
  const rawMax = Number(config.captchaClickIntervalMaxMs);

  const hasFixed = Number.isFinite(fixed) && fixed >= 0;
  const hasMin = Number.isFinite(rawMin) && rawMin >= 0;
  const hasMax = Number.isFinite(rawMax) && rawMax >= 0;

  let min = hasMin ? rawMin : (hasFixed ? fixed : 200);
  let max = hasMax ? rawMax : (hasFixed ? fixed : min);

  if (!hasMin && hasMax) min = max;
  if (!hasMax && hasMin) max = min;
  if (min > max) [min, max] = [max, min];

  const minInt = Math.round(min);
  const maxInt = Math.round(max);
  return randomIntBetween(minInt, maxInt);
}

async function waitCaptchaClickInterval(page, config = {}) {
  await page.waitForTimeout(getCaptchaClickDelayMs(config));
}

function padNumber(value, length = 2) {
  return String(value).padStart(length, "0");
}

function formatLogTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    padNumber(date.getMonth() + 1),
    padNumber(date.getDate()),
  ].join("/")
    + ` ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${padNumber(date.getMilliseconds(), 3)}`;
}

function log(message) {
  const tag = workerStorage.getStore() || "";
  const now = formatLogTimestamp();
  console.log(`[${now}]${tag} ${message}`);
}

function workerArtifactSuffix() {
  const tag = workerStorage.getStore() || "";
  const cleaned = tag.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  return cleaned ? `-${cleaned}` : "";
}

function accountLogTag(config = {}) {
  const name = normalizeText(config.accountName || config.name);
  return name ? `[${name}]` : "";
}

function workerLogTag(config = {}, index = 0) {
  const name = normalizeText(config.accountName || config.name);
  return name ? `[${name}:T${index + 1}]` : `[T${index + 1}]`;
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeTimeText(value) {
  return normalizeText(value).replace(/\b(\d):/g, "0$1:");
}

function normalizeSlotTimes(slot = {}) {
  const rawTimes = Array.isArray(slot.times)
    ? slot.times
    : Array.isArray(slot.time)
      ? slot.time
      : [slot.time];

  return [...new Set(rawTimes.map(normalizeTimeText).filter(Boolean))];
}

function normalizeSlotPreference(slot = {}) {
  const court = normalizeText(slot.court);
  const times = normalizeSlotTimes(slot);
  return {
    ...slot,
    court,
    times,
    time: times[0] || "",
  };
}

function formatSlotPreference(slot = {}) {
  const court = normalizeText(slot.court);
  const times = normalizeSlotTimes(slot);
  return [court, times.join(" / ")].filter(Boolean).join(" ");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLocalDateTime(raw) {
  const text = normalizeText(raw);
  if (!text) return null;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(text)) {
    return new Date(text);
  }
  return new Date(text.replace(" ", "T"));
}

function parseCourtNumber(courtText) {
  const match = normalizeText(courtText).match(/^(\d+)/);
  if (!match) return NaN;
  return Number.parseInt(match[1], 10);
}

function replaceVenueReservationId(url, venueId) {
  const text = normalizeText(url);
  if (!text) return "";
  return text.replace(/\/venue\/venue-reservation\/\d+(?=$|[/?#])/, `/venue/venue-reservation/${venueId}`);
}

function resolveReservationUrlFromCourt(courtText, fallbackUrl = "") {
  const courtNo = parseCourtNumber(courtText);
  if (courtNo >= 1 && courtNo <= 12) {
    return replaceVenueReservationId(fallbackUrl, "38") || DEFAULT_VENUE_URL_38;
  }
  if (courtNo >= 17 && courtNo <= 24) {
    return replaceVenueReservationId(fallbackUrl, "39") || DEFAULT_VENUE_URL_39;
  }
  return normalizeText(fallbackUrl);
}

function getSlotReservationUrl(slot = {}, fallbackUrl = "") {
  return normalizeText(slot.venueUrl) || resolveReservationUrlFromCourt(slot.court, fallbackUrl);
}

function isBookablePriceText(cellText) {
  const text = normalizeText(cellText);
  return /^[¥￥]\s*\d+(?:\.\d{1,2})?$/.test(text);
}

function normalizeReservationUrl(url) {
  return normalizeText(url).replace(/\/+$/, "");
}

function sameReservationUrl(left, right) {
  return normalizeReservationUrl(left) === normalizeReservationUrl(right);
}

function resolveRunUrl(config = {}, slotPreferences = config.slotPreferences || []) {
  const slots = Array.isArray(slotPreferences) ? slotPreferences : [];
  if (slots.length === 0) return normalizeText(config.url);
  return getSlotReservationUrl(slots[0], config.url) || normalizeText(config.url);
}

function getConfiguredConcurrency(config = {}) {
  const concurrency = Number(config.concurrency ?? 1);
  return Number.isFinite(concurrency) && concurrency > 0 ? Math.floor(concurrency) : 1;
}

function normalizeRuntimeConfig(baseConfig = {}, accountConfig = null) {
  const merged = { ...baseConfig, ...(accountConfig || {}) };
  const url = normalizeText(merged.url);
  const browserExecutablePath = normalizeText(merged.browserExecutablePath);
  const accountName = normalizeText(merged.name || merged.accountName);
  const slotPreferences = Array.isArray(merged.slotPreferences)
    ? merged.slotPreferences
      .map(normalizeSlotPreference)
      .filter((slot) => slot.court && slot.times.length > 0)
      .map((slot) => ({
        ...slot,
        venueUrl: resolveReservationUrlFromCourt(slot.court, url),
      }))
    : [];

  const normalized = {
    ...merged,
    url,
    name: accountName || normalizeText(merged.name),
    accountName,
    enabled: accountConfig ? accountConfig.enabled !== false : merged.enabled !== false,
    userDataDir: path.resolve(process.cwd(), merged.userDataDir || ".playwright-profile"),
    browserExecutablePath: browserExecutablePath ? path.resolve(process.cwd(), browserExecutablePath) : "",
    releaseTime: normalizeText(merged.releaseTime),
    dateText: normalizeText(merged.dateText),
    warmupDateText: normalizeText(merged.warmupDateText),
    companions: Array.isArray(merged.companions) ? merged.companions.map(normalizeText).filter(Boolean) : [],
    refreshDateTexts: Array.isArray(merged.refreshDateTexts)
      ? merged.refreshDateTexts.map(normalizeText).filter(Boolean)
      : [],
    slotPreferences,
  };
  delete normalized.accounts;
  return normalized;
}

async function readConfig() {
  const raw = await fs.readFile(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  const baseConfig = { ...config };
  delete baseConfig.accounts;

  const normalizedConfig = normalizeRuntimeConfig(baseConfig);
  const accounts = Array.isArray(config.accounts)
    ? config.accounts.map((account) => normalizeRuntimeConfig(baseConfig, account))
    : [];

  return {
    ...normalizedConfig,
    accounts,
  };
}

async function ensureArtifactsDir() {
  const artifactsDir = path.resolve(process.cwd(), "artifacts");
  await fs.mkdir(artifactsDir, { recursive: true });
  return artifactsDir;
}

async function listProfileProcesses(profileDir) {
  try {
    const { stdout } = await execFileAsync("ps", ["aux"]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(
        (line) => line.includes(profileDir) && PROFILE_BROWSER_KEYWORDS.some((keyword) => line.includes(keyword)),
      );
  } catch {
    return [];
  }
}

async function pathExists(targetPath) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveBrowserExecutablePath(config) {
  if (config.browserExecutablePath) {
    if (await pathExists(config.browserExecutablePath)) {
      return {
        executablePath: config.browserExecutablePath,
        source: "config",
      };
    }
    throw new Error(`config.json 中的 browserExecutablePath 不存在: ${config.browserExecutablePath}`);
  }

  let candidates = [];
  if (process.platform === "darwin") {
    const homeDir = process.env.HOME ? path.join(process.env.HOME, "Applications") : "";
    candidates = [
      ...MAC_BROWSER_CANDIDATES,
      ...(homeDir
        ? [
            path.join(homeDir, "Google Chrome.app/Contents/MacOS/Google Chrome"),
            path.join(homeDir, "Chromium.app/Contents/MacOS/Chromium"),
            path.join(homeDir, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
          ]
        : []),
    ];
  } else if (process.platform === "linux") {
    candidates = LINUX_BROWSER_CANDIDATES;
  } else {
    return null;
  }

  for (const executablePath of candidates) {
    if (await pathExists(executablePath)) {
      return {
        executablePath,
        source: "system",
      };
    }
  }

  return null;
}

function isMissingPlaywrightBrowserError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Executable doesn't exist");
}

function normalizeViewportOption(value) {
  if (!value || typeof value !== "object") return null;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200) {
    return null;
  }
  return {
    width: Math.floor(width),
    height: Math.floor(height),
  };
}

function normalizeWindowPositionOption(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
  };
}

function buildLaunchOptions(config, args, executablePath) {
  const viewport = normalizeViewportOption(config.viewport);
  const windowPosition = normalizeWindowPositionOption(config.windowPosition);
  const deviceScaleFactor = Number(config.deviceScaleFactor);
  const hasDeviceScaleFactor = Number.isFinite(deviceScaleFactor) && deviceScaleFactor > 0;
  const disableProxy = config.disableProxy !== false;
  const proxyArgs = disableProxy ? ["--no-proxy-server"] : [];
  const launchArgs = viewport
    ? [
        `--window-size=${viewport.width},${viewport.height}`,
        ...(windowPosition ? [`--window-position=${windowPosition.x},${windowPosition.y}`] : []),
        ...(hasDeviceScaleFactor ? [`--force-device-scale-factor=${deviceScaleFactor}`] : []),
        ...proxyArgs,
      ]
    : [
        "--start-maximized",
        ...(windowPosition ? [`--window-position=${windowPosition.x},${windowPosition.y}`] : []),
        ...proxyArgs,
      ];

  return {
    headless: args.headless ?? config.headless ?? false,
    viewport: viewport || null,
    ...(hasDeviceScaleFactor ? { deviceScaleFactor } : {}),
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    args: launchArgs,
    ...(executablePath ? { executablePath } : {}),
  };
}

function extractPid(processLine) {
  const parts = processLine.split(/\s+/);
  return parts[1] || "";
}

async function cleanupStaleProfileLocks(profileDir) {
  const processes = await listProfileProcesses(profileDir);
  if (processes.length > 0) {
    return {
      cleaned: false,
      inUse: true,
      processes,
    };
  }

  const lockNames = ["SingletonLock", "SingletonCookie", "SingletonSocket"];
  let cleanedAny = false;
  for (const name of lockNames) {
    const target = path.join(profileDir, name);
    try {
      await fs.rm(target, { force: true });
      cleanedAny = true;
    } catch {
      // Ignore.
    }
  }

  return {
    cleaned: cleanedAny,
    inUse: false,
    processes: [],
  };
}

async function saveScreenshot(page, name) {
  const artifactsDir = await ensureArtifactsDir();
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}.png`;
  const target = path.join(artifactsDir, filename);
  await page.screenshot({ path: target, fullPage: true });
  log(`已保存截图: ${target}`);
}

async function saveDebugScreenshot(page, name, config = {}) {
  if (!config.debugScreenshots) return;
  await saveScreenshot(page, name);
}

async function screenshotViewportRect(page, rect) {
  // getBoundingClientRect() returns viewport-relative coordinates.
  // Playwright page.screenshot({ clip }) without fullPage uses the same viewport coordinate space,
  // so we must NOT add scrollX/scrollY — just clamp to the viewport bounds.
  const vp = page.viewportSize() || { width: 1280, height: 900 };

  const x = Math.max(0, Math.round(rect.left));
  const y = Math.max(0, Math.round(rect.top));
  const width = Math.min(Math.round(rect.width), vp.width - x);
  const height = Math.min(Math.round(rect.height), vp.height - y);

  if (width < 1 || height < 1) {
    throw new Error("验证码截图区域超出视口");
  }

  return await page.screenshot({ clip: { x, y, width, height } });
}

function readPngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return null;
  const isPng = buffer[0] === 0x89
    && buffer[1] === 0x50
    && buffer[2] === 0x4e
    && buffer[3] === 0x47
    && buffer[4] === 0x0d
    && buffer[5] === 0x0a
    && buffer[6] === 0x1a
    && buffer[7] === 0x0a;
  if (!isPng) return null;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

async function screenshotViewportRectWithScale(page, rect) {
  const vp = page.viewportSize() || { width: 1280, height: 900 };
  const clip = {
    x: Math.max(0, Math.round(rect.left)),
    y: Math.max(0, Math.round(rect.top)),
    width: Math.min(Math.round(rect.width), vp.width - Math.max(0, Math.round(rect.left))),
    height: Math.min(Math.round(rect.height), vp.height - Math.max(0, Math.round(rect.top))),
  };

  if (clip.width < 1 || clip.height < 1) {
    throw new Error("验证码截图区域超出视口");
  }

  const buffer = await page.screenshot({ clip });
  const size = readPngSize(buffer) || { width: clip.width, height: clip.height };
  const scaleX = size.width / Math.max(1, clip.width);
  const scaleY = size.height / Math.max(1, clip.height);
  return {
    buffer,
    clip,
    imageWidth: size.width,
    imageHeight: size.height,
    scaleX,
    scaleY,
  };
}

function screenshotPointToCssPoint(rect, shot, point) {
  return {
    x: rect.left + point.x / Math.max(shot.scaleX || 1, 0.001),
    y: rect.top + point.y / Math.max(shot.scaleY || 1, 0.001),
  };
}

async function clickCaptchaScreenshotPoint(page, dialogRect, shot, point, config) {
  const cssPoint = screenshotPointToCssPoint(dialogRect, shot, point);
  log(`点击位置(CSS): (${Math.round(cssPoint.x)}, ${Math.round(cssPoint.y)})`);
  await page.mouse.click(cssPoint.x, cssPoint.y);
  await waitCaptchaClickInterval(page, config);
}

async function promptEnter(message) {
  if (!process.stdin.isTTY) {
    log(message);
    return;
  }
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(`${message}\n按回车继续...`);
  } finally {
    rl.close();
  }
}

async function pageText(page) {
  return normalizeText(
    await page.evaluate(() => document.body.innerText || document.body.textContent || ""),
  );
}

async function collectUiSnapshot(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const normalizeTime = (value) => String(value || "").replace(/\b(\d):/g, "0$1:").trim();
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const bodyText = normalize(document.body?.innerText || document.body?.textContent || "");
    const visibleDates = Array.from(document.querySelectorAll(".date_box > div"))
      .filter((el) => isDisplayed(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean)
      .slice(0, 8);

    const visibleTables = Array.from(document.querySelectorAll("table"))
      .filter((table) => isDisplayed(table))
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });

    const slotHeaders = Array.from(visibleTables[0]?.querySelectorAll("tr:first-child th, tr:first-child td") || [])
      .map((cell) => normalizeTime(normalize(cell.textContent)))
      .filter((text) => /\d{2}:\d{2}-\d{2}:\d{2}/.test(text))
      .slice(0, 8);

    const hasBlockingLoading = [
      ".loading.ivu-spin-show-t",
      ".ivu-spin-show-text",
      ".ivu-spin-fix",
      ".ivu-modal-mask",
    ].some((selector) =>
      Array.from(document.querySelectorAll(selector)).some((el) => isDisplayed(el)),
    );

    return {
      hasBlockingLoading,
      hasFormatError: bodyText.includes("返回数据格式不正确"),
      visibleDates,
      slotHeaders,
      tableCount: visibleTables.length,
      scrollHeight: document.body?.scrollHeight || 0,
      bodyPreview: bodyText.slice(0, 180),
    };
  });
}

async function waitForUiIdle(page, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2500;
  const intervalMs = options.intervalMs ?? 120;
  const stableRounds = options.stableRounds ?? 2;
  const requireDateCards = options.requireDateCards ?? false;
  const requireSlotGrid = options.requireSlotGrid ?? false;

  const start = Date.now();
  let lastFingerprint = "";
  let stableCount = 0;
  let lastSnapshot = null;

  while (Date.now() - start < timeoutMs) {
    const snapshot = await collectUiSnapshot(page);
    lastSnapshot = snapshot;

    if (snapshot.hasFormatError) {
      return { ok: false, reason: "bad-data", snapshot };
    }

    const readyForDates = !requireDateCards || snapshot.visibleDates.length > 0;
    const readyForSlotGrid = !requireSlotGrid || snapshot.slotHeaders.length > 0;

    if (!snapshot.hasBlockingLoading && readyForDates && readyForSlotGrid) {
      const fingerprint = JSON.stringify({
        visibleDates: snapshot.visibleDates,
        slotHeaders: snapshot.slotHeaders,
        tableCount: snapshot.tableCount,
        scrollHeight: snapshot.scrollHeight,
        bodyPreview: snapshot.bodyPreview,
      });

      if (fingerprint === lastFingerprint) {
        stableCount += 1;
      } else {
        lastFingerprint = fingerprint;
        stableCount = 1;
      }

      if (stableCount >= stableRounds) {
        return { ok: true, reason: "stable", snapshot };
      }
    } else {
      lastFingerprint = "";
      stableCount = 0;
    }

    await page.waitForTimeout(intervalMs);
  }

  return { ok: false, reason: "timeout", snapshot: lastSnapshot };
}

async function findTextTarget(page, targetText, options = {}) {
  const { exact = true, prefer = "topmost" } = options;

  return page.evaluate(
    ({ targetText: innerTargetText, exact: innerExact, prefer: innerPrefer }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isDisplayed = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const target = normalize(innerTargetText);
      const candidates = [];

      for (const el of document.querySelectorAll("*")) {
        if (!isDisplayed(el)) continue;
        const text = normalize(el.textContent);
        if (!text) continue;

        const matched = innerExact ? text === target : text.includes(target);
        if (!matched) continue;

        const rect = el.getBoundingClientRect();
        const childHit = Array.from(el.children).some((child) => {
          if (!isDisplayed(child)) return false;
          const childText = normalize(child.textContent);
          return innerExact ? childText === target : childText.includes(target);
        });

        candidates.push({
          text,
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          area: rect.width * rect.height,
          childHit,
        });
      }

      const filtered = candidates.filter((item) => !item.childHit);
      const finalCandidates = filtered.length > 0 ? filtered : candidates;

      finalCandidates.sort((a, b) => {
        if (innerPrefer === "lowest") {
          return b.rect.top - a.rect.top || a.area - b.area;
        }
        if (innerPrefer === "smallest") {
          return a.area - b.area || a.rect.top - b.rect.top;
        }
        return a.rect.top - b.rect.top || a.area - b.area;
      });

      const winner = finalCandidates[0];
      if (!winner) return null;

      window.scrollBy(0, Math.max(0, winner.rect.top - window.innerHeight / 2));

      return true;
    },
    { targetText, exact, prefer },
  );
}

async function clickText(page, targetText, options = {}) {
  const idle = await waitForUiIdle(page, {
    timeoutMs: options.idleTimeoutMs ?? 1800,
    intervalMs: options.idleIntervalMs ?? 100,
    stableRounds: options.stableRounds ?? 1,
    requireDateCards: options.requireDateCards ?? false,
    requireSlotGrid: options.requireSlotGrid ?? false,
  });
  if (!idle.ok) return false;

  const ok = await findTextTarget(page, targetText, options);
  if (!ok) return false;

  const point = await page.evaluate(
    ({ targetText: innerTargetText, exact: innerExact, prefer: innerPrefer }) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isDisplayed = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const target = normalize(innerTargetText);
      const candidates = [];

      for (const el of document.querySelectorAll("*")) {
        if (!isDisplayed(el)) continue;
        const text = normalize(el.textContent);
        if (!text) continue;
        const matched = innerExact ? text === target : text.includes(target);
        if (!matched) continue;

        const rect = el.getBoundingClientRect();
        const childHit = Array.from(el.children).some((child) => {
          if (!isDisplayed(child)) return false;
          const childText = normalize(child.textContent);
          return innerExact ? childText === target : childText.includes(target);
        });

        candidates.push({
          rect: {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
          },
          area: rect.width * rect.height,
          childHit,
        });
      }

      const filtered = candidates.filter((item) => !item.childHit);
      const finalCandidates = filtered.length > 0 ? filtered : candidates;

      finalCandidates.sort((a, b) => {
        if (innerPrefer === "lowest") {
          return b.rect.top - a.rect.top || a.area - b.area;
        }
        if (innerPrefer === "smallest") {
          return a.area - b.area || a.rect.top - b.rect.top;
        }
        return a.rect.top - b.rect.top || a.area - b.area;
      });

      const winner = finalCandidates[0];
      if (!winner) return null;

      return {
        x: winner.rect.left + winner.rect.width / 2,
        y: winner.rect.top + winner.rect.height / 2,
      };
    },
    { targetText, exact: options.exact ?? true, prefer: options.prefer ?? "topmost" },
  );

  if (!point) return false;
  await page.mouse.click(point.x, point.y);
  return true;
}

async function selectDateCard(page, dateText, timeoutMs = 8000, options = {}) {
  const idle = await waitForUiIdle(page, {
    timeoutMs: Math.min(timeoutMs, 1800),
    intervalMs: 100,
    stableRounds: 1,
    requireDateCards: true,
  });
  if (!idle.ok) return false;

  const clicked = await page.evaluate((targetText) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const cards = Array.from(document.querySelectorAll(".date_box > div"))
      .filter((el) => isDisplayed(el));

    const target = cards.find((el) => normalize(el.textContent).includes(targetText));
    if (!target) return false;

    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  }, dateText);

  if (!clicked) return false;

  const start = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? 80;
  while (Date.now() - start < timeoutMs) {
    const selected = await page.evaluate((targetText) => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const cards = Array.from(document.querySelectorAll(".date_box > div"));
      const target = cards.find((el) => normalize(el.textContent).includes(targetText));
      if (!(target instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(target);
      const bg = style.backgroundColor;
      const color = style.color;
      return bg === "rgb(222, 241, 255)" && color === "rgb(0, 91, 172)";
    }, dateText);

    if (selected) return true;
    await page.waitForTimeout(pollIntervalMs);
  }

  return false;
}

async function isDateCardSelected(page, dateText) {
  return page.evaluate((targetText) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const cards = Array.from(document.querySelectorAll(".date_box > div"));
    const target = cards.find((el) => normalize(el.textContent).includes(targetText));
    if (!(target instanceof HTMLElement)) return false;
    const style = window.getComputedStyle(target);
    return style.backgroundColor === "rgb(222, 241, 255)" && style.color === "rgb(0, 91, 172)";
  }, dateText);
}

async function listVisibleDateTexts(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    return Array.from(document.querySelectorAll(".date_box > div"))
      .filter((el) => isDisplayed(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);
  });
}

async function waitForDateCardsReady(page, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dateTexts = await listVisibleDateTexts(page);
    if (dateTexts.length > 0) {
      return dateTexts;
    }
    await page.waitForTimeout(500);
  }
  return [];
}

async function hasVisibleDateText(page, dateText) {
  const dateTexts = await listVisibleDateTexts(page);
  const target = normalizeText(dateText);
  return dateTexts.some((text) => text.includes(target));
}

async function pickDate(page, dateText, options = {}) {
  const normalizedDateText = normalizeText(dateText);
  if (!normalizedDateText) return false;

  let pickedDate = await selectDateCard(page, normalizedDateText, options.timeoutMs ?? 8000, options);
  if (!pickedDate) {
    pickedDate = await clickText(page, normalizedDateText, { exact: true, prefer: "topmost" });
  }
  if (!pickedDate) {
    pickedDate = await clickText(page, normalizedDateText, { exact: false, prefer: "smallest" });
  }

  return pickedDate;
}

async function activateDateImmediately(page, dateText, options = {}) {
  const normalizedDateText = normalizeText(dateText);
  if (!normalizedDateText) return false;

  if (await isDateCardSelected(page, normalizedDateText)) {
    return true;
  }

  const maxAttempts = options.maxAttempts ?? 2;
  const timeoutMs = options.timeoutMs ?? 1200;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const picked = await selectDateCard(page, normalizedDateText, timeoutMs, options);
    if (picked && await isDateCardSelected(page, normalizedDateText)) {
      return true;
    }

    const text = await pageText(page);
    if (text.includes("返回数据格式不正确")) {
      log(`点击日期 ${normalizedDateText} 后返回数据格式不正确，刷新页面重试...`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForDateCardsReady(page, 5000).catch(() => {});
      return false;
    }

    if (attempt < maxAttempts) {
      await page.waitForTimeout(120);
    }
  }

  return false;
}

async function resolveSlotPoint(page, courtText, timeText) {
  return page.evaluate(({ courtText: innerCourtText, timeText: innerTimeText }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    // 补齐前导零，使 "7:00-8:00" 和 "07:00-08:00" 都能匹配
    const normalizeTime = (t) => String(t || "").replace(/\b(\d):/g, "0$1:").trim();
    const normalizedTimeText = normalizeTime(innerTimeText);
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const visibleTables = Array.from(document.querySelectorAll("table"))
      .filter((table) => isDisplayed(table))
      .map((table) => {
        const rect = table.getBoundingClientRect();
        return { table, rect, area: rect.width * rect.height };
      })
      .sort((a, b) => b.area - a.area);

    for (const { table } of visibleTables) {
      const rows = Array.from(table.querySelectorAll("tr"))
        .map((tr) => ({
          tr,
          cells: Array.from(tr.querySelectorAll("td,th")),
        }))
        .filter((row) => row.cells.length > 0);

      const headerRow = rows.find((row) => row.cells.some((cell) => normalizeTime(normalize(cell.textContent)) === normalizedTimeText));
      if (!headerRow) continue;

      const timeColIndex = headerRow.cells.findIndex((cell) => normalizeTime(normalize(cell.textContent)) === normalizedTimeText);
      if (timeColIndex < 0) continue;

      const targetRow = rows.find((row) => row.cells.some((cell) => normalize(cell.textContent) === innerCourtText) && row.cells.length > timeColIndex);
      if (!targetRow) continue;

      const slotCell = targetRow.cells[timeColIndex];
      if (!slotCell || !isDisplayed(slotCell)) continue;

      slotCell.scrollIntoView({ block: "center", inline: "center" });
      const rect = slotCell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        courtRect: rect,
        timeRect: rect,
        cellText: normalize(slotCell.textContent),
      };
    }

    return null;
  }, { courtText, timeText });
}

async function clickSlot(page, courtText, timeText, options = {}) {
  const idle = await waitForUiIdle(page, {
    timeoutMs: options.idleTimeoutMs ?? 700,
    intervalMs: options.idleIntervalMs ?? 80,
    stableRounds: 1,
    requireSlotGrid: true,
  });
  if (!idle.ok) return null;

  const point = await page.evaluate(({ courtText: innerCourtText, timeText: innerTimeText }) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const normalizeTime = (t) => String(t || "").replace(/\b(\d):/g, "0$1:").trim();
    const normalizedTimeText = normalizeTime(innerTimeText);
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const visibleTables = Array.from(document.querySelectorAll("table"))
      .filter((table) => isDisplayed(table))
      .map((table) => {
        const rect = table.getBoundingClientRect();
        return { table, rect, area: rect.width * rect.height };
      })
      .sort((a, b) => b.area - a.area);

    for (const { table } of visibleTables) {
      const rows = Array.from(table.querySelectorAll("tr"))
        .map((tr) => ({
          cells: Array.from(tr.querySelectorAll("td,th")),
        }))
        .filter((row) => row.cells.length > 0);

      const headerRow = rows.find((row) => row.cells.some((cell) => normalizeTime(normalize(cell.textContent)) === normalizedTimeText));
      if (!headerRow) continue;

      const timeColIndex = headerRow.cells.findIndex((cell) => normalizeTime(normalize(cell.textContent)) === normalizedTimeText);
      if (timeColIndex < 0) continue;

      const targetRow = rows.find((row) => row.cells.some((cell) => normalize(cell.textContent) === innerCourtText) && row.cells.length > timeColIndex);
      if (!targetRow) continue;

      const slotCell = targetRow.cells[timeColIndex];
      if (!slotCell || !isDisplayed(slotCell)) continue;

      slotCell.scrollIntoView({ block: "center", inline: "center" });
      const clickable = Array.from(slotCell.querySelectorAll("*")).find((el) => isDisplayed(el)) || slotCell;
      if (clickable instanceof HTMLElement) {
        clickable.click();
      } else {
        slotCell.click();
      }

      const rect = slotCell.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;

      return {
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        cellText: normalize(slotCell.textContent),
      };
    }

    return null;
  }, { courtText, timeText });

  if (!point) return null;
  return point;
}

async function scrollSlotGridRight(page) {
  const idle = await waitForUiIdle(page, {
    timeoutMs: 1800,
    intervalMs: 100,
    stableRounds: 1,
    requireSlotGrid: true,
  });
  if (!idle.ok) return false;

  const result = await page.evaluate(() => {
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };

    const tables = Array.from(document.querySelectorAll("table"))
      .filter((t) => isDisplayed(t))
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });
    if (tables.length === 0) return { clicked: false, debug: "no table" };
    const table = tables[0];
    const tableRect = table.getBoundingClientRect();

    const inHeaderArea = (el) => {
      const r = el.getBoundingClientRect();
      return r.top >= tableRect.top - 80 && r.top <= tableRect.top + 100;
    };

    // 策略1：文字精确为 ">" 的元素（不限子元素数量）
    const byText = Array.from(document.querySelectorAll("*"))
      .filter((el) => isDisplayed(el) && inHeaderArea(el) && (el.textContent || "").trim() === ">")
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    if (byText.length > 0) {
      byText[0].click();
      return { clicked: true, how: "text=>", tag: byText[0].tagName, cls: String(byText[0].className).slice(0, 60) };
    }

    // 策略2：已知 iView/Element/Ant 类名，优先在 table 内部搜索，避免点到面包屑导航的同名图标
    const classNames = [
      "ivu-icon-ios-arrow-forward", "ivu-icon-ios-arrow-right",
      "el-icon-arrow-right", "el-icon-caret-right", "el-icon-d-arrow-right",
      "anticon-right", "anticon-caret-right",
    ];
    // table 的父级容器（iView table wrapper），限制搜索范围到 slot grid 区域
    const tableContainer = table.closest("[class*='ivu-table']") || table.parentElement || table;
    for (const cls of classNames) {
      // 优先在 table 容器内找（排除面包屑等页面其他区域）
      const globalEl = document.querySelector(`.${cls}`);
      const el = tableContainer.querySelector(`.${cls}`) || (globalEl && inHeaderArea(globalEl) ? globalEl : null);
      if (el && isDisplayed(el)) {
        el.click();
        return { clicked: true, how: `class:${cls}`, tag: el.tagName };
      }
    }

    // 策略3：table 右边缘附近、尺寸小的可点击元素（排除 loading overlay）
    const rightEdge = tableRect.right;
    const small = Array.from(document.querySelectorAll("span,i,button,a,div,td,th"))
      .filter((el) => {
        if (!isDisplayed(el) || !inHeaderArea(el)) return false;
        const cls = String(el.className || "");
        if (cls.includes("ivu-spin") || cls.includes("loading")) return false; // 排除 loading 遮罩
        const r = el.getBoundingClientRect();
        return r.left >= rightEdge - 80 && r.width <= 80 && r.height <= 60;
      })
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);
    if (small.length > 0) {
      small[0].click();
      return { clicked: true, how: "rightEdge", tag: small[0].tagName, cls: String(small[0].className).slice(0, 60), txt: (small[0].textContent || "").trim().slice(0, 10) };
    }

    // 策略4：elementFromPoint 沿右边缘扫描（排除 loading overlay）
    const hy = tableRect.top + 20;
    for (let x = Math.min(rightEdge + 30, window.innerWidth - 5); x >= rightEdge - 60; x -= 8) {
      const el = document.elementFromPoint(x, hy);
      if (!el || !isDisplayed(el)) continue;
      const tag = el.tagName;
      if (tag === "TABLE" || tag === "THEAD" || tag === "TR" || tag === "HTML" || tag === "BODY") continue;
      const cls = String(el.className || "");
      if (cls.includes("ivu-spin") || cls.includes("loading")) continue; // 排除 loading 遮罩
      el.click();
      return { clicked: true, how: `point(${Math.round(x)},${Math.round(hy)})`, tag, cls: cls.slice(0, 60), txt: (el.textContent || "").trim().slice(0, 10) };
    }

    // 调试：收集 header 区域所有可见元素信息
    const debug = Array.from(document.querySelectorAll("*"))
      .filter((el) => isDisplayed(el) && inHeaderArea(el))
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.left > tableRect.right - 150;
      })
      .map((el) => ({ tag: el.tagName, cls: String(el.className).slice(0, 40), txt: (el.textContent || "").trim().slice(0, 12) }));
    return { clicked: false, debug };
  });

  if (result.clicked) {
    log(`翻页箭头已点击 [${result.how}] <${result.tag}> cls="${result.cls || ""}" txt="${result.txt || ""}"`);
    return true;
  }
  // 未找到时输出调试信息
  log(`翻页箭头未找到，header区右侧元素: ${JSON.stringify(result.debug).slice(0, 300)}`);
  return false;
}

// 根据开始小时算出目标页码（从1开始）
// 第1页: 07-11点 | 第2页: 12-16点 | 第3页: 17-21点
function getSlotPage(timeText) {
  const match = String(timeText).match(/(\d{1,2}):/);
  if (!match) return 1;
  const hour = parseInt(match[1], 10);
  if (hour < 12) return 1;
  if (hour < 17) return 2;
  return 3;
}

async function getCurrentSlotPage(page) {
  return page.evaluate(() => {
    const normalizeTime = (t) => String(t || "").replace(/\b(\d):/g, "0$1:").trim();
    const normalize = (v) => String(v || "").replace(/\s+/g, " ").trim();
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const s = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
    };

    const tables = Array.from(document.querySelectorAll("table")).filter(isDisplayed);
    if (tables.length === 0) return { page: 0, headers: [] };
    tables.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return rb.width * rb.height - ra.width * ra.height;
    });
    const headerCells = Array.from(tables[0].querySelectorAll("tr:first-child th, tr:first-child td"))
      .map((c) => normalizeTime(normalize(c.textContent)))
      .filter((t) => /\d{2}:\d{2}-\d{2}:\d{2}/.test(t));
    if (headerCells.length === 0) return { page: 0, headers: [] };
    const firstHour = parseInt(headerCells[0].split(":")[0], 10);
    if (firstHour < 12) return { page: 1, headers: headerCells };
    if (firstHour < 17) return { page: 2, headers: headerCells };
    return { page: 3, headers: headerCells };
  });
}

async function waitForSlotPage(page, expectedPage, targetTimeText = "", timeoutMs = 700) {
  const normalizedTargetTime = normalizeTimeText(targetTimeText);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await getCurrentSlotPage(page).catch(() => ({ page: 0, headers: [] }));
    if (state.page === expectedPage) {
      return state;
    }
    if (normalizedTargetTime && state.headers.includes(normalizedTargetTime)) {
      return state;
    }
    await page.waitForTimeout(50);
  }
  return null;
}

function markPreparedStateDirty(preparedState) {
  if (!preparedState) return;
  preparedState.companionsReady = false;
  preparedState.phoneReady = false;
  preparedState.agreeReady = false;
}

async function recoverSlotGridPage(page, reason, courtText, timeText, dateText, options = {}) {
  log(`${reason}，重载后重新进入日期 ${dateText || "目标日期"}。`);
  await page.reload({ waitUntil: "domcontentloaded" });
  markPreparedStateDirty(options.preparedState);
  await waitForReservationView(page, { dateText }).catch(() => {});
  await waitForDateCardsReady(page, 5000).catch(() => []);
  if (dateText) {
    await activateDateImmediately(page, dateText, {
      timeoutMs: 1500,
      pollIntervalMs: options.dateCardPollIntervalMs,
    }).catch(() => false);
  }
}

async function inspectSlotGridState(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const normalizeTime = (value) => String(value || "").replace(/\b(\d):/g, "0$1:").trim();
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const tables = Array.from(document.querySelectorAll("table"))
      .filter((table) => isDisplayed(table))
      .sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.width * rb.height - ra.width * ra.height;
      });
    if (tables.length === 0) {
      return { hasSlotGrid: false, hasSkeletonOnly: false, headerCells: [], firstColumn: [] };
    }

    const table = tables[0];
    const rows = Array.from(table.querySelectorAll("tr"));
    const headerCells = Array.from(rows[0]?.querySelectorAll("th,td") || [])
      .map((cell) => normalizeTime(normalize(cell.textContent)))
      .filter(Boolean);
    const timeHeaders = headerCells.filter((text) => /\d{2}:\d{2}-\d{2}:\d{2}/.test(text));
    const firstColumn = rows
      .slice(0, 4)
      .map((row) => normalize(row.querySelector("th,td")?.textContent))
      .filter(Boolean);
    const nonEmptyHeaders = headerCells.filter((text) => text && text !== "场地");
    const hasSkeletonOnly = timeHeaders.length === 0
      && firstColumn.length > 0
      && firstColumn.every((text) => text === "场地")
      && nonEmptyHeaders.length === 0;

    return {
      hasSlotGrid: timeHeaders.length > 0,
      hasSkeletonOnly,
      headerCells,
      firstColumn,
    };
  });
}

async function waitForSlotGridReady(page, courtText, timeText, timeoutMs = 15000, dateText = "", options = {}) {
  const start = Date.now();
  let recoveryCount = 0;
  const maxRecoveries = options.maxRecoveries ?? 2;
  const recoveryAfterMs = options.recoveryAfterMs ?? 1500;

  // 1. 等待 slot grid table 出现（区分于 order form 的普通 table），处理"返回数据格式不正确"
  let phase1Count = 0;
  while (Date.now() - start < timeoutMs) {
    const text = await pageText(page);
    if (text.includes("返回数据格式不正确")) {
      log("格子加载时返回数据格式不正确，刷新页面重试...");
      await page.reload({ waitUntil: "domcontentloaded" });
      markPreparedStateDirty(options.preparedState);
      await page.waitForTimeout(500);
      phase1Count = 0;
      continue;
    }

    const visibleDates = await listVisibleDateTexts(page).catch(() => []);
    const emptySchedule = text.includes("未安排场地空间时间段");
    const missingDateCards = Boolean(dateText) && visibleDates.length === 0;
    const waitedLongEnough = Date.now() - start >= recoveryAfterMs;
    if ((emptySchedule || missingDateCards) && recoveryCount < maxRecoveries && waitedLongEnough) {
      const reason = emptySchedule ? "空白场地时间段" : "日期卡片消失";
      await recoverSlotGridPage(page, `检测到页面处于异常状态（${reason}）`, courtText, timeText, dateText, options);
      recoveryCount += 1;
      phase1Count = 0;
      continue;
    }

    // 等 loading 遮罩消失
    await page.waitForFunction(
      () => !document.querySelector(".loading.ivu-spin-show-t"),
      undefined,
      { timeout: 2000 },
    ).catch(() => {});

    const slotGridState = await inspectSlotGridState(page).catch(() => ({
      hasSlotGrid: false,
      hasSkeletonOnly: false,
      headerCells: [],
      firstColumn: [],
    }));
    if (slotGridState.hasSlotGrid) {
      // table 骨架先出，翻页箭头稍后渲染，等箭头就绪再翻页
      await page.waitForFunction(
        () => !!document.querySelector(".ivu-icon-ios-arrow-forward"),
        undefined,
        { timeout: 3000 },
      ).catch(() => {});
      break;
    }

    if (slotGridState.hasSkeletonOnly && recoveryCount < maxRecoveries && waitedLongEnough) {
      await recoverSlotGridPage(page, "检测到 slot grid 只有骨架未返回时间列", courtText, timeText, dateText, options);
      recoveryCount += 1;
      phase1Count = 0;
      continue;
    }

    phase1Count++;
    // 每 10 次 × 400ms ≈ 4 秒仍无 slot grid，重新点击日期触发数据加载
    if (dateText && phase1Count % 10 === 0) {
      log(`slot grid 未出现（等待 ${Math.round((Date.now() - start) / 1000)}s），重新点击日期: ${dateText}`);
      await pickDate(page, dateText, {
        timeoutMs: 1000,
        pollIntervalMs: options.dateCardPollIntervalMs,
      }).catch(() => {});
    }
    await page.waitForTimeout(400);
  }

  // 2. 循环：找格子 → 等 loading → 检测当前页 → 按需翻页（应对数据加载后页面复位）
  const targetPage = getSlotPage(timeText);
  let scrollCount = 0;
  const maxScrolls = 10;

  while (Date.now() - start < timeoutMs) {
    // 先尝试找格子
    const point = await resolveSlotPoint(page, courtText, timeText);
    if (point) return point;

    // 等 loading 遮罩消失，再判断当前页（避免 loading 时拿到空表头）
    await page.waitForFunction(
      () => !document.querySelector(".loading.ivu-spin-show-t"),
      undefined,
      { timeout: 3000 },
    ).catch(() => {});

    const waitedLongEnough = Date.now() - start >= recoveryAfterMs;
    const text = await pageText(page);
    const visibleDates = await listVisibleDateTexts(page).catch(() => []);
    const slotGridState = await inspectSlotGridState(page).catch(() => ({
      hasSlotGrid: false,
      hasSkeletonOnly: false,
      headerCells: [],
      firstColumn: [],
    }));
    const emptySchedule = text.includes("未安排场地空间时间段");
    const missingDateCards = Boolean(dateText) && visibleDates.length === 0;
    const badData = text.includes("返回数据格式不正确");
    if ((badData || emptySchedule || missingDateCards || slotGridState.hasSkeletonOnly)
      && recoveryCount < maxRecoveries
      && waitedLongEnough) {
      const reason = badData
        ? "检测到返回数据格式不正确"
        : emptySchedule
          ? "检测到页面退化为空白场地时间段"
          : missingDateCards
            ? "检测到日期卡片在找格子阶段消失"
            : "检测到找格子阶段只剩 slot grid 骨架";
      await recoverSlotGridPage(page, reason, courtText, timeText, dateText, options);
      recoveryCount += 1;
      continue;
    }

    // 找不到：检测当前在第几页
    const currentPageState = await getCurrentSlotPage(page).catch(() => ({ page: 0, headers: [] }));
    const currentPage = currentPageState.page;

    if (currentPage > 0 && currentPage < targetPage && scrollCount < maxScrolls) {
      // 当前页不够，按页推进；每次确认表头已切到下一页后立刻继续
      let advanced = false;
      for (let nextPage = currentPage + 1; nextPage <= targetPage && scrollCount < maxScrolls; nextPage += 1) {
        const scrolled = await scrollSlotGridRight(page);
        if (!scrolled) {
          break;
        }
        scrollCount++;
        log(`当前第 ${nextPage - 1} 页，翻向第 ${targetPage} 页（第 ${scrollCount} 次翻页）`);
        const pageChanged = await waitForSlotPage(page, nextPage, timeText, options.scrollPageChangeTimeoutMs ?? 700);
        if (!pageChanged) {
          const pointAfterScroll = await resolveSlotPoint(page, courtText, timeText);
          if (pointAfterScroll) {
            return pointAfterScroll;
          }
          await page.waitForTimeout(150);
          break;
        }
        advanced = true;
        await saveDebugScreenshot(page, `scroll-p${nextPage}-${courtText}-${timeText}-${scrollCount}`, {
          debugScreenshots: options.debugScreenshots,
        }).catch(() => {});
      }
      if (!advanced) {
        await page.waitForTimeout(150);
      }
    } else {
      // 已到目标页或数据还在加载，等格子渲染
      await page.waitForTimeout(300);
    }
  }

  return null;
}

async function fillPhone(page, phone) {
  if (!normalizeText(phone)) return false;

  const index = await page.evaluate(() => {
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const inputs = Array.from(document.querySelectorAll("input"));
    const candidates = inputs
      .map((input, idx) => ({ input, idx }))
      .filter(({ input }) => {
        if (!(input instanceof HTMLInputElement)) return false;
        if (!isDisplayed(input) || input.disabled || input.readOnly) return false;
        const type = (input.type || "text").toLowerCase();
        return !["hidden", "checkbox", "radio", "file", "button", "submit"].includes(type);
      })
      .map(({ input, idx }) => {
        const surrounding = (input.closest("div,form,section")?.textContent || "") + (input.labels?.[0]?.textContent || "");
        return {
          idx,
          score: surrounding.includes("手机号") ? 10 : 0,
        };
      })
      .sort((a, b) => b.score - a.score || a.idx - b.idx);

    return candidates[0]?.idx ?? -1;
  });

  if (index < 0) return false;
  const inputHandle = page.locator("input").nth(index);
  await inputHandle.click();
  await inputHandle.fill(phone);
  return true;
}

async function fillReservationAncillaryFields(page, config, options = {}) {
  const stageLabel = normalizeText(options.stageLabel) || "填写";
  const actionDelayMs = config.actionDelayMs || 500;
  let companionsReady = config.companions.length === 0;
  let phoneReady = !config.phone;
  let agreeReady = !config.agreeText;

  if (config.companions.length > 0) {
    companionsReady = true;
    for (const companion of config.companions) {
      log(`${stageLabel}同伴: ${companion}`);
      const clicked = await clickText(page, companion, { exact: true, prefer: "topmost" });
      if (!clicked) {
        log(`${stageLabel}时没有找到同伴文本: ${companion}`);
        companionsReady = false;
        continue;
      }
      await page.waitForTimeout(actionDelayMs);
    }
  }

  if (config.phone) {
    const filled = await fillPhone(page, config.phone);
    phoneReady = filled;
    if (filled) {
      log(`${stageLabel}手机号完成。`);
    } else {
      log(`${stageLabel}时没有自动定位到手机号输入框。`);
    }
    await page.waitForTimeout(actionDelayMs);
  }

  if (config.agreeText) {
    const agreed = await clickText(page, config.agreeText, { exact: false, prefer: "lowest" });
    agreeReady = agreed;
    if (agreed) {
      log(`${stageLabel}预约须知完成。`);
      await page.waitForTimeout(actionDelayMs);
    } else {
      log(`${stageLabel}时没有找到"已阅读并同意"文本。`);
    }
  }

  return {
    companionsReady,
    phoneReady,
    agreeReady,
  };
}

async function warmupReservation(page, config) {
  await waitForReservationBaseReady(page, 30000);
  const visibleDates = await waitForDateCardsReady(page, 30000);
  log(`预热阶段可见日期: ${visibleDates.join(" / ") || "无"}`);
  const warmupDateText = normalizeText(config.warmupDateText)
    || visibleDates.find((text) => text !== config.dateText)
    || visibleDates[0]
    || "";

  if (warmupDateText) {
    log(`预热阶段先进入日期: ${warmupDateText}`);
    const picked = await pickDate(page, warmupDateText, {
      timeoutMs: 2000,
      pollIntervalMs: config.dateCardPollIntervalMs,
    });
    if (!picked) {
      log(`预热阶段没有点到日期: ${warmupDateText}`);
    } else {
      await waitForUiIdle(page, {
        timeoutMs: Math.max(1200, config.actionDelayMs || 500),
        intervalMs: 120,
        stableRounds: 1,
        requireDateCards: true,
      }).catch(() => {});
    }
  } else {
    log("预热阶段没有找到可切换的日期卡片。");
  }

  return fillReservationAncillaryFields(page, config, { stageLabel: "预填写" });
}

// 返回 didHardReload: 若做过整页 reload，表单预填状态已失效，调用方需重置
async function findTargetDateAfterRelease(page, config) {
  if (config.refreshDateTexts.length > 0) {
    const { foundDate, didHardReload } = await waitForTargetDateByRefreshDates(page, config);
    if (foundDate) {
      log(`已通过日期切换看到目标日期 ${config.dateText}。`);
    } else {
      log("日期切换刷新结束后仍未看到目标日期，继续尝试后续步骤。");
    }
    return didHardReload;
  } else if (config.reloadAtRelease) {
    const delayMs = config.releaseDelayMs ?? 50;
    if (delayMs > 0) {
      log(`等待 ${delayMs}ms 后刷新...`);
      await sleep(delayMs);
    }
    let dateFound = false;
    for (let i = 0; i < 20; i++) {
      log(i === 0 ? "开始前刷新页面。" : `目标日期未出现，第 ${i + 1} 次重试刷新...`);
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForUiIdle(page, {
        timeoutMs: 1200,
        intervalMs: 120,
        stableRounds: 1,
      }).catch(() => {});
      const text = await pageText(page);
      if (text.includes(config.dateText)) {
        log(`已找到日期 ${config.dateText}，直接开始抢号。`);
        dateFound = true;
        break;
      }
      if (i < 19) await sleep(500);
    }
    if (!dateFound) {
      log("重试结束仍未找到目标日期，继续尝试后续步骤。");
      await waitForReservationView(page, config);
    }
    return true; // reloadAtRelease 模式也属于整页 reload
  }
  return false;
}

async function waitForTargetDateByRefreshDates(page, config) {
  const targetDateText = normalizeText(config.dateText);
  const refreshDateTexts = [...new Set(config.refreshDateTexts.filter((text) => text !== targetDateText))];
  if (!targetDateText || refreshDateTexts.length === 0) {
    return { foundDate: false, didHardReload: false };
  }

  const timeoutMs = config.refreshDateTimeoutMs ?? 15000;
  const switchDelayMs = config.refreshDateSwitchDelayMs ?? 300;
  const start = Date.now();
  const releaseMs = config.releaseTime ? parseLocalDateTime(config.releaseTime)?.getTime() : Date.now();

  // 如果目标日期已经可见（脚本比预期晚启动），立即进入
  if (await hasVisibleDateText(page, targetDateText)) {
    log(`目标日期 ${targetDateText} 已经可见，立即点击进入。`);
    const activated = await activateDateImmediately(page, targetDateText, {
      pollIntervalMs: config.dateCardPollIntervalMs,
    });
    if (!activated) throw new Error(`目标日期 ${targetDateText} 已出现，但立即点击进入失败。`);
    return { foundDate: true, didHardReload: false };
  }

  // ── 阶段2：日期切换刷新（约 200ms 节奏），持续到 release + 2000ms ────────────
  // 切换日期会触发 API 请求，有机会拿到含目标日期的最新响应
  const phase3Start = releaseMs + 2000;
  let switchIdx = 0;
  while (Date.now() < phase3Start && Date.now() - start < timeoutMs) {
    if (await hasVisibleDateText(page, targetDateText)) {
      log(`目标日期 ${targetDateText} 已出现，立即点击进入。`);
      const activated = await activateDateImmediately(page, targetDateText, {
        pollIntervalMs: config.dateCardPollIntervalMs,
      });
      if (!activated) throw new Error(`目标日期 ${targetDateText} 已出现，但立即点击进入失败。`);
      return { foundDate: true, didHardReload: false };
    }
    const refreshDateText = refreshDateTexts[switchIdx % refreshDateTexts.length];
    switchIdx++;
    log(`[阶段2] 切换日期刷新: ${refreshDateText}`);
    await pickDate(page, refreshDateText, {
      timeoutMs: 500,
      pollIntervalMs: config.dateCardPollIntervalMs,
    }).catch(() => {});
    await waitForUiIdle(page, {
      timeoutMs: Math.max(switchDelayMs, 200),
      intervalMs: 60,
      stableRounds: 1,
      requireDateCards: true,
    }).catch(() => {});
  }

  // ── 阶段3：7:00:02 之后，整页硬刷新（每次 reload 后检测目标日期）──────────
  // 整页 reload 比 API 调用更稳定，服务器一旦正常响应立即可见目标日期
  let didHardReload = false;
  while (Date.now() - start < timeoutMs) {
    if (await hasVisibleDateText(page, targetDateText)) {
      log(`目标日期 ${targetDateText} 已出现，立即点击进入。`);
      const activated = await activateDateImmediately(page, targetDateText, {
        pollIntervalMs: config.dateCardPollIntervalMs,
      });
      if (!activated) throw new Error(`目标日期 ${targetDateText} 已出现，但立即点击进入失败。`);
      return { foundDate: true, didHardReload };
    }
    log("目标日期未出现，硬刷新页面...");
    await page.reload({ waitUntil: "domcontentloaded" });
    didHardReload = true;
    await waitForUiIdle(page, {
      timeoutMs: 1200,
      intervalMs: 120,
      stableRounds: 1,
    }).catch(() => {});
  }

  return { foundDate: false, didHardReload };
}

async function hasTargetSelection(page, courtText, timeText) {
  const text = await pageText(page);
  // 规范化时间：去除前导零对比变体，如 "7:00-8:00" 和 "07:00-08:00" 都要能匹配
  const normalizeTime = (t) => String(t || "").replace(/\b0(\d):/g, "$1:");
  const timeAlt = normalizeTime(timeText); // 去掉前导零的变体
  const makeTimePattern = (t) => escapeRegExp(t).replace(/-/, "[-～~]"); // 支持不同连字符
  const timePattern = `(?:${makeTimePattern(timeText)}|${makeTimePattern(timeAlt)})`;
  const selectedPattern = new RegExp(`已选\\s*${escapeRegExp(courtText)}\\s*[：:]\\s*${timePattern}`);
  const fallbackPattern = new RegExp(`${escapeRegExp(courtText)}\\s*[：:]\\s*${timePattern}`);
  const hasPositiveAmount = /订单金额[:：]\s*¥\s*(?!0(?:\.0+)?元?)/.test(text);
  return selectedPattern.test(text) || (fallbackPattern.test(text) && hasPositiveAmount);
}

async function waitForTargetSelection(page, courtText, timeText, timeoutMs = 3000, options = {}) {
  const start = Date.now();
  const pollIntervalMs = options.pollIntervalMs ?? 80;
  while (Date.now() - start < timeoutMs) {
    if (await hasTargetSelection(page, courtText, timeText)) {
      return true;
    }
    await page.waitForTimeout(pollIntervalMs);
  }
  return false;
}

async function confirmSelectedTimes(page, courtText, timeTexts) {
  const confirmed = [];
  for (const timeText of timeTexts) {
    if (await hasTargetSelection(page, courtText, timeText)) {
      confirmed.push(timeText);
    }
  }
  return confirmed;
}

async function waitForReservationView(page, config = {}) {
  await page.waitForLoadState("domcontentloaded");

  const maxWaitMs = 20000;
  const start = Date.now();
  let loggedWaiting = false;

  while (Date.now() - start < maxWaitMs) {
    const text = await pageText(page);

    if (text.includes("返回数据格式不正确")) {
      log("预约视图加载时返回数据格式不正确，刷新页面重试...");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      continue;
    }

    if (text.includes("请登录后访问")) {
      throw new Error("当前登录态对预约接口无效，请先重新手动登录。");
    }

    const hasDateText = config.dateText ? text.includes(config.dateText) : /\d{2}月\d{2}日/.test(text);
    const hasDateSection = text.includes("选择日期");

    if (hasDateSection && hasDateText) {
      return;
    }

    if (!loggedWaiting) {
      log("等待预约页面数据加载完成...");
      loggedWaiting = true;
    }
    await page.waitForTimeout(1000);
  }

  log("页面等待超时，继续尝试执行后续步骤。");
}

async function waitForReservationBaseReady(page, timeoutMs = 20000) {
  await page.waitForLoadState("domcontentloaded");

  const start = Date.now();
  let loggedWaiting = false;

  while (Date.now() - start < timeoutMs) {
    const text = await pageText(page);

    if (text.includes("返回数据格式不正确")) {
      log("基础页面加载时返回数据格式不正确，刷新页面重试...");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout(500);
      continue;
    }

    if (text.includes("请登录后访问")) {
      throw new Error("当前登录态对预约接口无效，请先重新手动登录。");
    }

    const hasDateSection = text.includes("选择日期");
    const visibleDates = await listVisibleDateTexts(page);
    if (hasDateSection && visibleDates.length > 0) {
      return;
    }

    if (!loggedWaiting) {
      log("等待预约基础页面加载完成...");
      loggedWaiting = true;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("预约基础页面加载超时，日期卡片一直没有出现。");
}

async function maybeLogin(page, args) {
  const text = await pageText(page);
  const hasReservationFields = text.includes("选择日期") || text.includes("同伴") || text.includes("预约须知");
  const appearsLoggedOut = text.includes("登录") && !hasReservationFields;

  if (!args.login && !appearsLoggedOut) return;

  log("浏览器已打开，请在这个 Playwright 浏览器窗口里手动完成登录。");
  await promptEnter("登录完成并回到预约页后");
}

async function waitUntilRelease(releaseTimeRaw) {
  const releaseTime = parseLocalDateTime(releaseTimeRaw);
  if (!releaseTime || Number.isNaN(releaseTime.getTime())) return;

  let remaining = releaseTime.getTime() - Date.now();
  if (remaining <= 0) return;

  log(`距离开抢还有 ${Math.ceil(remaining / 1000)} 秒，脚本会在页面保持打开并等待。`);
  while (remaining > 0) {
    const step = Math.min(remaining, remaining > 60000 ? 30000 : remaining);
    await sleep(step);
    remaining = releaseTime.getTime() - Date.now();
    if (remaining > 0 && remaining <= 60000) {
      log(`还剩 ${Math.ceil(remaining / 1000)} 秒。`);
    }
  }
}

async function waitForSubmitOutcome(page, config, timeoutMs = 4500) {
  const submitText = normalizeText(config.submitText) || "提交";
  const captchaPromptText = normalizeText(config.captchaPromptText);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const text = await pageText(page);
    if (text.includes("返回数据格式不正确")) {
      return { state: "bad-data" };
    }
    if (captchaPromptText && text.includes(captchaPromptText)) {
      return { state: "captcha" };
    }
    if (!text.includes(submitText)) {
      return { state: "navigated" };
    }

    const idle = await waitForUiIdle(page, {
      timeoutMs: 400,
      intervalMs: 100,
      stableRounds: 1,
    });
    if (idle.reason === "bad-data") {
      return { state: "bad-data" };
    }
    if (idle.ok) {
      return { state: "stable-still-visible" };
    }

    await page.waitForTimeout(150);
  }

  return { state: "timeout" };
}

async function runInspect(page) {
  const snapshot = await page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const allTexts = Array.from(document.querySelectorAll("*"))
      .filter((el) => isDisplayed(el))
      .map((el) => normalize(el.textContent))
      .filter(Boolean);

    const uniqueTexts = [...new Set(allTexts)];
    return {
      title: document.title,
      url: location.href,
      dateTexts: uniqueTexts.filter((text) => /^\d{2}月\d{2}日$/.test(text)).slice(0, 20),
      weekdayTexts: uniqueTexts.filter((text) => /^星期[一二三四五六日天]$/.test(text)).slice(0, 20),
      timeTexts: uniqueTexts.filter((text) => /^\d{2}:\d{2}-\d{2}:\d{2}$/.test(text)).slice(0, 30),
      courtTexts: uniqueTexts.filter((text) => /^\d+号$/.test(text)).slice(0, 30),
      keyTexts: uniqueTexts.filter((text) => ["选择日期", "同伴", "提交", "预约须知", "请完成安全验证"].some((key) => text.includes(key))).slice(0, 20),
      bodyPreview: normalize(document.body.innerText).slice(0, 1200),
    };
  });

  console.log(JSON.stringify(snapshot, null, 2));
  await saveScreenshot(page, "inspect");
}

async function locateCaptchaDialog(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const withRect = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
        area: rect.width * rect.height,
      };
    };

    const unionRect = (a, b) => {
      const left = Math.min(a.left, b.left);
      const top = Math.min(a.top, b.top);
      const right = Math.max(a.right, b.right);
      const bottom = Math.max(a.bottom, b.bottom);
      return {
        left,
        top,
        width: right - left,
        height: bottom - top,
        right,
        bottom,
        area: Math.max(0, right - left) * Math.max(0, bottom - top),
      };
    };

    const ancestors = (el) => {
      const list = [];
      let cur = el;
      while (cur && cur instanceof HTMLElement) {
        list.push(cur);
        cur = cur.parentElement;
      }
      return list;
    };

    const bodyText = normalize(document.body?.innerText || document.body?.textContent || "");
    if (!bodyText.includes("请完成安全验证")) return null;

    const promptElements = Array.from(document.querySelectorAll("div, span, p"))
      .filter((el) => isDisplayed(el) && normalize(el.textContent).includes("请依次点击"));
    const mediaElements = Array.from(document.querySelectorAll("img, canvas"))
      .filter((el) => {
        if (!isDisplayed(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 180 && rect.height >= 100;
      });

    const pairCandidates = [];
    for (const promptEl of promptElements) {
      const promptRect = withRect(promptEl);
      for (const mediaEl of mediaElements) {
        const mediaRect = withRect(mediaEl);
        const verticalGap = promptRect.top - mediaRect.bottom;
        const overlapWidth = Math.max(0, Math.min(promptRect.right, mediaRect.right) - Math.max(promptRect.left, mediaRect.left));
        const overlapRatio = overlapWidth / Math.max(1, Math.min(promptRect.width, mediaRect.width));
        const centerDelta = Math.abs((promptRect.left + promptRect.width / 2) - (mediaRect.left + mediaRect.width / 2));
        const horizontalClose = overlapRatio >= 0.25 || centerDelta <= Math.max(promptRect.width, mediaRect.width) * 0.6;
        const verticalClose = verticalGap >= -10 && verticalGap <= 220;
        if (!horizontalClose || !verticalClose) continue;

        const merged = unionRect(promptRect, mediaRect);
        if (merged.width < 220 || merged.height < 180 || merged.top < 0) continue;
        pairCandidates.push(merged);
      }
    }

    pairCandidates.sort((a, b) => a.area - b.area);
    const pairWinner = pairCandidates[0];
    if (pairWinner) {
      const { left, top, width, height } = pairWinner;
      return { left, top, width, height };
    }

    const candidateSet = new Set();

    for (const promptEl of promptElements) {
      for (const ancestor of ancestors(promptEl)) {
        if (ancestor.querySelector("img, canvas")) {
          candidateSet.add(ancestor);
        }
      }
    }

    for (const mediaEl of mediaElements) {
      for (const ancestor of ancestors(mediaEl)) {
        const text = normalize(ancestor.textContent);
        if (text.includes("请依次点击") || text.includes("请完成安全验证")) {
          candidateSet.add(ancestor);
        }
      }
    }

    const modalCandidates = Array.from(candidateSet)
      .filter((el) => isDisplayed(el))
      .map((el) => ({ el, ...withRect(el), text: normalize(el.textContent) }))
      .filter((item) =>
        item.width > 200
        && item.height > 150
        && item.top >= 0
        && item.left >= -50
        && (item.text.includes("请完成安全验证") || item.text.includes("请依次点击"))
        && item.el.querySelector("img, canvas"),
      )
      .sort((a, b) => a.area - b.area);

    const winner = modalCandidates[0];
    if (!winner) return null;
    const { left, top, width, height } = winner;
    return { left, top, width, height };
  });
}

async function waitForCaptchaDialog(page, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dialogRect = await locateCaptchaDialog(page);
    if (dialogRect) {
      return dialogRect;
    }
    await page.waitForTimeout(120);
  }
  return null;
}

async function waitForCaptchaTargets(page, timeoutMs = 1200) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const targetChars = await page.evaluate(() => {
      const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
      const isDisplayed = (el) => {
        if (!(el instanceof HTMLElement)) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const parseTargets = (text) => {
        const match = String(text || "").match(/[【\[]\s*([^】\]]+?)\s*[】\]]/);
        if (!match) return [];
        return match[1]
          .replace(/[，、]/g, ",")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
      };

      const promptTexts = Array.from(document.querySelectorAll("div, span, p"))
        .filter((el) => isDisplayed(el))
        .map((el) => normalize(el.textContent))
        .filter((text) => text.includes("请依次点击"));

      for (const text of promptTexts) {
        const parsed = parseTargets(text);
        if (parsed.length > 0) return parsed;
      }

      const bodyText = normalize(document.body.innerText || document.body.textContent || "");
      return parseTargets(bodyText);
    }).catch(() => []);

    if (targetChars.length > 0) {
      return targetChars;
    }

    await page.waitForTimeout(80);
  }

  return [];
}

async function locateCaptchaImageRect(page) {
  return page.evaluate(() => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const isDisplayed = (el) => {
      if (!(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };

    const withRect = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom,
        area: rect.width * rect.height,
      };
    };

    const bodyText = normalize(document.body?.innerText || document.body?.textContent || "");
    if (!bodyText.includes("请完成安全验证")) return null;

    const promptElements = Array.from(document.querySelectorAll("div, span, p"))
      .filter((el) => isDisplayed(el) && normalize(el.textContent).includes("请依次点击"));
    const mediaElements = Array.from(document.querySelectorAll("img, canvas"))
      .filter((el) => {
        if (!isDisplayed(el)) return false;
        const rect = el.getBoundingClientRect();
        return rect.width >= 180 && rect.height >= 100;
      });

    const mediaCandidates = [];
    for (const promptEl of promptElements) {
      const promptRect = withRect(promptEl);
      for (const mediaEl of mediaElements) {
        const mediaRect = withRect(mediaEl);
        const verticalGap = promptRect.top - mediaRect.bottom;
        const overlapWidth = Math.max(0, Math.min(promptRect.right, mediaRect.right) - Math.max(promptRect.left, mediaRect.left));
        const overlapRatio = overlapWidth / Math.max(1, Math.min(promptRect.width, mediaRect.width));
        const centerDelta = Math.abs((promptRect.left + promptRect.width / 2) - (mediaRect.left + mediaRect.width / 2));
        const horizontalClose = overlapRatio >= 0.25 || centerDelta <= Math.max(promptRect.width, mediaRect.width) * 0.6;
        const verticalClose = verticalGap >= -10 && verticalGap <= 220;
        if (!horizontalClose || !verticalClose) continue;
        mediaCandidates.push(mediaRect);
      }
    }

    mediaCandidates.sort((a, b) => a.area - b.area);
    const mediaRect = mediaCandidates[0];
    if (!mediaRect) return null;

    const { left, top, width, height, right, bottom } = mediaRect;
    return { left, top, width, height, right, bottom };
  }).catch(() => null);
}

async function getCaptchaImageSignature(page, fallbackRect = null) {
  const imageRect = await locateCaptchaImageRect(page) || fallbackRect;
  if (!imageRect) return null;
  const imgBuffer = await screenshotViewportRect(page, imageRect).catch(() => null);
  if (!imgBuffer) return null;
  return {
    rect: imageRect,
    hash: createHash("md5").update(imgBuffer).digest("hex"),
  };
}

async function waitForCaptchaImageSettle(page, fallbackRect, config) {
  const timeoutMs = config.captchaRefreshSettleTimeoutMs ?? 900;
  const intervalMs = config.captchaRefreshSettleIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastHash = null;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const signature = await getCaptchaImageSignature(page, fallbackRect);
    const hash = signature?.hash;
    if (!hash) {
      await page.waitForTimeout(intervalMs);
      continue;
    }

    if (hash === lastHash) {
      stableCount += 1;
      if (stableCount >= 1) {
        log("验证码图片已稳定，开始下一轮识别。");
        return true;
      }
    } else {
      stableCount = 0;
      lastHash = hash;
    }

    await page.waitForTimeout(intervalMs);
  }

  log("等待验证码图片稳定超时，继续下一轮识别。");
  return false;
}

async function clickCaptchaRefresh(page, dialogRect, config) {
  const fallbackImageRect = {
    left: dialogRect.left,
    top: dialogRect.top,
    width: dialogRect.width,
    height: Math.max(Math.min(dialogRect.height * 0.7, dialogRect.height), 100),
    right: dialogRect.left + dialogRect.width,
    bottom: dialogRect.top + Math.max(Math.min(dialogRect.height * 0.7, dialogRect.height), 100),
  };
  const before = await getCaptchaImageSignature(page, fallbackImageRect);
  const imageRect = before?.rect || fallbackImageRect;

  const candidatePoints = [
    { x: imageRect.right - 12, y: imageRect.top + 14 },
    { x: imageRect.right - 20, y: imageRect.top + 14 },
    { x: imageRect.right - 12, y: imageRect.top + 24 },
    { x: imageRect.right - 28, y: imageRect.top + 18 },
  ].map((point) => ({
    x: Math.max(imageRect.left + imageRect.width * 0.7, point.x),
    y: Math.min(imageRect.bottom - 8, Math.max(imageRect.top + 8, point.y)),
  }));

  const tried = new Set();
  for (const point of candidatePoints) {
    const key = `${Math.round(point.x)},${Math.round(point.y)}`;
    if (tried.has(key)) continue;
    tried.add(key);

    await page.mouse.click(point.x, point.y);
    log(`点击验证码刷新位置(CSS): (${Math.round(point.x)}, ${Math.round(point.y)})`);
    await page.waitForTimeout(config.captchaRefreshWaitMs ?? 220);

    const after = await getCaptchaImageSignature(page, fallbackImageRect);
    if (!before?.hash || !after?.hash) {
      log("未能校验验证码图片是否已刷新，继续后续流程。");
      await waitForCaptchaImageSettle(page, fallbackImageRect, config);
      return;
    }
    if (after.hash !== before.hash) {
      log("已检测到验证码图片刷新成功。");
      await waitForCaptchaImageSettle(page, fallbackImageRect, config);
      return;
    }
  }

  log("多次尝试后仍未检测到验证码图片变化，继续后续流程。");
  await waitForCaptchaImageSettle(page, fallbackImageRect, config);
}

async function solveCaptchaWithChaojiying(page, config, maxAttempts = 3) {
  const { chaojiyingUser, chaojiyingPass, chaojiyingSoftid = "96001" } = config;
  const passMd5 = createHash("md5").update(chaojiyingPass).digest("hex");

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`验证码识别尝试第 ${attempt} 次...`);

    // 获取验证码弹窗整体区域（包含图片 + 提示文字，方便人工识别）
    const dialogRect = await waitForCaptchaDialog(page, 2500);

    if (!dialogRect || dialogRect.width === 0) {
      log("验证码提示已出现，但弹窗内容还没完全渲染出来，本次稍后重试。");
      await page.waitForTimeout(300);
      continue;
    }
    log(`弹窗区域: left=${Math.round(dialogRect.left)} top=${Math.round(dialogRect.top)} w=${Math.round(dialogRect.width)} h=${Math.round(dialogRect.height)}`);

    // 截取整个弹窗（含提示文字，超级鹰人工判题需要看到）
    const shot = await screenshotViewportRectWithScale(page, dialogRect);
    const imgBuffer = shot.buffer;
    log(`验证码截图: ${shot.imageWidth}x${shot.imageHeight}px，CSS区域 ${shot.clip.width}x${shot.clip.height}，scale=(${shot.scaleX.toFixed(3)},${shot.scaleY.toFixed(3)})`);
    const base64Image = imgBuffer.toString("base64");
    const artifactsDir = await ensureArtifactsDir();
    await fs.writeFile(path.join(artifactsDir, `captcha-${attempt}.png`), imgBuffer);

    // 调用超级鹰 API（坐标多选类，codetype=9004）
    let picId;
    let coordPairs;
    try {
      const params = new URLSearchParams({
        user: chaojiyingUser,
        pass2: passMd5,
        softid: chaojiyingSoftid,
        codetype: "9004",
        file_base64: base64Image,
      });

      const res = await fetch("http://upload.chaojiying.net/Upload/Processing.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      const result = await res.json();
      log(`超级鹰响应: err_no=${result.err_no} pic_str=${result.pic_str}`);

      if (result.err_no !== 0) {
        throw new Error(`超级鹰错误 ${result.err_no}: ${result.err_str}`);
      }

      picId = result.pic_id;
      // pic_str 格式: "x1,y1|x2,y2|x3,y3"（坐标相对于截图左上角）
      coordPairs = result.pic_str.split("|").map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return { x, y };
      });
    } catch (err) {
      log(`超级鹰识别失败: ${err.message}`);
      continue;
    }

    log(`识别坐标: ${coordPairs.map((p) => `(${p.x},${p.y})`).join(" → ")}`);

    // 点击坐标相对截图，按实际截图/CSS比例换回页面 CSS 坐标。
    for (const { x, y } of coordPairs) {
      await clickCaptchaScreenshotPoint(page, dialogRect, shot, { x, y }, config);
    }

    // 等待验证码弹窗消失
    const passed = await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText || document.body.textContent || "";
        return !bodyText.includes("请完成安全验证");
      },
      undefined,
      { timeout: config.captchaVerifyTimeoutMs ?? 3000 },
    ).then(() => true).catch(() => false);

    if (passed) {
      log("验证码验证通过！");
      return true;
    }

    // 答案错误，向超级鹰报错（退还积分）
    if (picId) {
      const reportParams = new URLSearchParams({
        user: chaojiyingUser,
        pass2: passMd5,
        softid: chaojiyingSoftid,
        id: picId,
      });
      await fetch("http://upload.chaojiying.net/Upload/ReportError.php", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: reportParams.toString(),
      }).catch(() => {});
      log("已向超级鹰报错，积分已退还。");
    }

    log("验证未通过，重试...");
    await page.waitForTimeout(800);
  }

  log(`验证码自动识别 ${maxAttempts} 次均失败，请手动完成验证。`);
  return false;
}

async function solveCaptchaWithGemini(page, config, maxAttempts = 3) {
  const { geminiApiKey, geminiBaseUrl, geminiModel = "gemini-3.1-pro-preview" } = config;
  const client = new OpenAI({ apiKey: geminiApiKey, baseURL: geminiBaseUrl, timeout: 120000 });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`Gemini 验证码识别尝试第 ${attempt} 次...`);

    const dialogRect = await waitForCaptchaDialog(page, 2500);

    if (!dialogRect) {
      log("验证码提示已出现，但弹窗内容还没完全渲染出来，本次稍后重试。");
      await page.waitForTimeout(300);
      continue;
    }
    log(`弹窗区域: left=${Math.round(dialogRect.left)} top=${Math.round(dialogRect.top)} w=${Math.round(dialogRect.width)} h=${Math.round(dialogRect.height)}`);

    const shot = await screenshotViewportRectWithScale(page, dialogRect);
    const imgBuffer = shot.buffer;
    log(`验证码截图: ${shot.imageWidth}x${shot.imageHeight}px，CSS区域 ${shot.clip.width}x${shot.clip.height}，scale=(${shot.scaleX.toFixed(3)},${shot.scaleY.toFixed(3)})`);
    const base64Image = imgBuffer.toString("base64");

    // 保存截图供调试
    const artifactsDir = await ensureArtifactsDir();
    await fs.writeFile(path.join(artifactsDir, `captcha-gemini-${attempt}.png`), imgBuffer);

    const imgWidth = shot.imageWidth;
    const imgHeight = shot.imageHeight;

    let coordPairs;
    try {
      const response = await client.chat.completions.create({
        model: geminiModel,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${base64Image}` },
              },
              {
                type: "text",
                text: `这是一个点击验证码截图，图片尺寸为 ${imgWidth}x${imgHeight} 像素。图片上方是验证码图像区域，包含若干像素风格彩色汉字叠加在背景图片上；图片下方有一行文字，格式为"请依次点击【字1,字2,字3】"，说明了需要依次点击的汉字顺序。

请按照下方文字要求，找到对应汉字在图片中的位置，以归一化坐标返回各汉字中心点（x 和 y 均为 0.0~1.0，相对于图片左上角）。

只返回 JSON，不要任何其他文字，格式如下：
{"coords": [[x1, y1], [x2, y2], [x3, y3]]}`,
              },
            ],
          },
        ],
        max_tokens: 8192,
      });

      const content = response.choices[0]?.message?.content?.trim() || "";
      log(`Gemini 响应: ${content}`);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`无法从响应中提取 JSON，原始内容: ${content}`);

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.coords) || parsed.coords.length === 0) {
        throw new Error("响应中 coords 字段格式不正确");
      }

      // 归一化坐标转截图像素，并验证在图片范围内
      coordPairs = parsed.coords.map(([nx, ny], i) => {
        const x = Number(nx);
        const y = Number(ny);
        // 兼容归一化 (0~1) 和绝对像素两种情况
        const px = x <= 1 ? x * imgWidth : x;
        const py = y <= 1 ? y * imgHeight : y;
        if (px < 0 || px > imgWidth || py < 0 || py > imgHeight) {
          throw new Error(`第 ${i + 1} 个坐标 (${px.toFixed(0)}, ${py.toFixed(0)}) 超出图片范围 ${imgWidth}x${imgHeight}`);
        }
        return { x: px, y: py };
      });
    } catch (err) {
      log(`Gemini 识别失败: ${err.message}`);
      continue;
    }

    log(`识别坐标(截图像素): ${coordPairs.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(" → ")}`);

    for (const { x, y } of coordPairs) {
      await clickCaptchaScreenshotPoint(page, dialogRect, shot, { x, y }, config);
    }

    const passed = await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText || document.body.textContent || "";
        return !bodyText.includes("请完成安全验证");
      },
      undefined,
      { timeout: config.captchaVerifyTimeoutMs ?? 3000 },
    ).then(() => true).catch(() => false);

    if (passed) {
      log("Gemini 验证码验证通过！");
      return true;
    }

    log("验证未通过，重试...");
    await page.waitForTimeout(800);
  }

  log(`Gemini 验证码识别 ${maxAttempts} 次均失败，请手动完成验证。`);
  return false;
}

async function solveCaptchaWithDdddocr(page, config, maxAttempts = 3) {
  const pythonBin = config.pythonBin || "python3";
  const scriptPath = path.resolve(process.cwd(), "solve_captcha.py");
  const ddddocrMode = normalizeText(config.captchaDdddocrMode) || "original";
  const ddddocrPool = config._ddddocrPool || null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(`ddddocr 验证码识别尝试第 ${attempt} 次...（mode=${ddddocrMode}）`);

    // 1. 找验证码弹窗区域
    const dialogRect = await waitForCaptchaDialog(page, 2500);

    if (!dialogRect) {
      log("验证码提示已出现，但弹窗内容还没完全渲染出来，本次稍后重试。");
      await page.waitForTimeout(300);
      continue;
    }
    log(`弹窗区域: left=${Math.round(dialogRect.left)} top=${Math.round(dialogRect.top)} w=${Math.round(dialogRect.width)} h=${Math.round(dialogRect.height)}`);

    // 2. DOM 解析目标字符（从"请依次点击【X,Y,Z】"提取）
    const targetChars = await waitForCaptchaTargets(page, config.captchaTargetParseTimeoutMs ?? 1800);

    if (targetChars.length === 0) {
      log("验证码提示文字还没完全渲染出来，稍后重试。");
      await page.waitForTimeout(150);
      continue;
    }
    log(`DOM 解析目标字: ${targetChars.join("、")}`);

    // 3. 截图并保存到临时文件
    const shot = await screenshotViewportRectWithScale(page, dialogRect);
    const imgBuffer = shot.buffer;
    log(`验证码截图: ${shot.imageWidth}x${shot.imageHeight}px，CSS区域 ${shot.clip.width}x${shot.clip.height}，scale=(${shot.scaleX.toFixed(3)},${shot.scaleY.toFixed(3)})`);

    // 4. 调用 Python 脚本（计时）
    let coordPairs;
    let result;
    const t0 = Date.now();
    try {
      if (ddddocrPool) {
        result = await ddddocrPool.solve(imgBuffer, targetChars, ddddocrMode);
      } else {
        const artifactsDir = await ensureArtifactsDir();
        const tmpImg = path.join(artifactsDir, `captcha-dddd${workerArtifactSuffix()}-${attempt}.png`);
        await fs.writeFile(tmpImg, imgBuffer);
        const { stdout } = await execFileAsync(pythonBin, [
          scriptPath,
          "--image", tmpImg,
          "--mode", ddddocrMode,
          "--targets", ...targetChars,
        ], {
          env: buildDdddocrEnv(config),
          timeout: 30000,
        });
        result = JSON.parse(stdout.trim());
      }
      const elapsed = Date.now() - t0;
      if (result.error) throw new Error(result.error);

      const coordStr = result.coords.map((c, i) =>
        c ? `「${targetChars[i]}」→(${c[0]},${c[1]})` : `「${targetChars[i]}」→未找到`
      ).join("  ");
      log(`ddddocr 耗时 ${elapsed}ms  ${coordStr}`);

      const allFound = result.found.every(Boolean);
      if (!allFound) {
        const missing = targetChars.filter((_, i) => !result.found[i]);
        log(`未找到字符: ${missing.join("、")}。本轮 OCR 结束。`);
        if (attempt < maxAttempts) {
          log("刷新验证码后进入下一轮识别...");
          await clickCaptchaRefresh(page, dialogRect, config);
        }
        continue;
      }

      coordPairs = result.coords.map(([x, y]) => ({ x, y }));
    } catch (err) {
      log(`ddddocr 识别失败: ${err.message}`);
      if (attempt < maxAttempts) {
        log("刷新验证码后进入下一轮识别...");
        await clickCaptchaRefresh(page, dialogRect, config);
      }
      continue;
    }

    log(`识别坐标: ${coordPairs.map((p) => `(${p.x},${p.y})`).join(" → ")}`);

    // 5. 点击（OCR 坐标相对截图，按实际截图/CSS比例换回页面 CSS 坐标）
    for (const { x, y } of coordPairs) {
      await clickCaptchaScreenshotPoint(page, dialogRect, shot, { x, y }, config);
    }

    // 6. 等待弹窗消失
    const passed = await page.waitForFunction(
      () => {
        const bodyText = document.body.innerText || document.body.textContent || "";
        return !bodyText.includes("请完成安全验证");
      },
      undefined,
      { timeout: config.captchaVerifyTimeoutMs ?? 3000 },
    ).then(() => true).catch(() => false);

    if (passed) {
      log("ddddocr 验证码验证通过！");
      return true;
    }

    log("验证未通过，本轮 OCR 结束。");
    if (attempt < maxAttempts) {
      log("刷新验证码后进入下一轮识别...");
      await clickCaptchaRefresh(page, dialogRect, config);
    }
  }

  log(`ddddocr 验证码识别 ${maxAttempts} 次均失败，请手动完成验证。`);
  return false;
}

async function reserve(page, config, preparedState = {}) {
  if (!config.dateText) {
    throw new Error("config.json 里的 dateText 不能为空。");
  }
  if (config.slotPreferences.length === 0) {
    throw new Error("config.json 里的 slotPreferences 至少要配一个场地和时段（time 或 times）。");
  }

  await waitForReservationView(page, config);
  await waitForDateCardsReady(page, 30000);

  const alreadyOnTargetDate = await isDateCardSelected(page, config.dateText);
  if (alreadyOnTargetDate) {
    log(`目标日期 ${config.dateText} 已经进入，直接开始抢号。`);
  } else {
    log(`尝试选择日期: ${config.dateText}`);
    const pickedDate = await activateDateImmediately(page, config.dateText, {
      timeoutMs: 2000,
      pollIntervalMs: config.dateCardPollIntervalMs,
    });
    if (!pickedDate) {
      throw new Error(`没有找到日期文本: ${config.dateText}`);
    }
  }

  let pickedSlotSummary = null;
  for (const slot of config.slotPreferences) {
    const courtText = normalizeText(slot.court);
    const timeTexts = normalizeSlotTimes(slot);
    if (!courtText || timeTexts.length === 0) continue;
    const slotUrl = getSlotReservationUrl(slot, config.url);

    if (slotUrl && !sameReservationUrl(page.url(), slotUrl)) {
      log(`切换到场地 ${courtText} 对应场馆页面: ${slotUrl}`);
      await page.goto(slotUrl, { waitUntil: "domcontentloaded" });
      markPreparedStateDirty(preparedState);
      await waitForReservationBaseReady(page, 30000);
      await waitForReservationView(page, config);
      await waitForDateCardsReady(page, 30000);
      const pickedDate = await activateDateImmediately(page, config.dateText, {
        timeoutMs: 2000,
        pollIntervalMs: config.dateCardPollIntervalMs,
      });
      if (!pickedDate) {
        throw new Error(`切换场馆后没有找到日期文本: ${config.dateText}`);
      }
    }

    log(`尝试选择场地: ${courtText} ${timeTexts.join(" / ")}`);
    const pickedTimes = [];

    for (const timeText of timeTexts) {
      const readyPoint = await waitForSlotGridReady(page, courtText, timeText, 15000, config.dateText, {
        preparedState,
        debugScreenshots: config.debugScreenshots,
        scrollPageChangeTimeoutMs: config.scrollPageChangeTimeoutMs,
        maxRecoveries: pickedTimes.length > 0 ? 0 : undefined,
        dateCardPollIntervalMs: config.dateCardPollIntervalMs,
      });
      if (!readyPoint) {
        // 输出当前页面可见的时间列和场地名，方便排查
        const pageState = await page.evaluate(() => {
          const normalize = (v) => String(v || "").replace(/\s+/g, " ").trim();
          const normalizeTime = (t) => String(t || "").replace(/\b(\d):/g, "0$1:").trim();
          const isDisplayed = (el) => {
            if (!(el instanceof HTMLElement)) return false;
            const s = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== "none" && s.visibility !== "hidden" && r.width > 0 && r.height > 0;
          };
          const tables = Array.from(document.querySelectorAll("table")).filter(isDisplayed);
          if (tables.length === 0) return { times: [], courts: [] };
          tables.sort((a, b) => {
            const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
            return rb.width * rb.height - ra.width * ra.height;
          });
          const table = tables[0];
          const rows = Array.from(table.querySelectorAll("tr"));
          const times = Array.from(rows[0]?.querySelectorAll("th,td") || [])
            .map((c) => normalizeTime(normalize(c.textContent)))
            .filter((t) => /\d{2}:\d{2}/.test(t));
          const courts = rows.slice(1).map((r) => normalize(r.cells[0]?.textContent)).filter(Boolean);
          return { times, courts };
        }).catch(() => ({ times: [], courts: [] }));
        log(`未定位到格子: ${courtText} ${timeText}｜当前时间列: [${pageState.times.join(", ")}]｜场地列: [${pageState.courts.slice(0, 10).join(", ")}]`);
        continue;
      }

      let currentTimePicked = false;
      for (let attempt = 1; attempt <= config.selectionRetryCount; attempt += 1) {
        const clicked = await clickSlot(page, courtText, timeText, {
          idleTimeoutMs: config.slotClickIdleTimeoutMs,
          idleIntervalMs: config.slotClickIdleIntervalMs,
        });
        if (!clicked) {
          log(`未定位到格子: ${courtText} ${timeText}`);
          break;
        }

        if (clicked.cellText) {
          log(`当前格子文本: ${clicked.cellText}`);
          if (!isBookablePriceText(clicked.cellText)) {
            log(`非价格文本，直接跳过：${clicked.cellText}`);
            break;
          }
        }

        const selected = await waitForTargetSelection(
          page,
          courtText,
          timeText,
          Math.max(3000, (config.actionDelayMs || 500) * 6),
          { pollIntervalMs: config.slotSelectionPollIntervalMs },
        );
        if (selected) {
          log(`已选中: ${courtText} ${timeText}`);
          pickedTimes.push(timeText);
          currentTimePicked = true;
          break;
        }

        log(`第 ${attempt} 次点击后还没看到选中状态，继续重试。`);
      }

      if (!currentTimePicked) {
        log(`场地 ${courtText} ${timeText} 本轮未选中。`);
      }
    }

    const confirmedTimes = await confirmSelectedTimes(page, courtText, pickedTimes);
    if (confirmedTimes.length === 0) {
      continue;
    }

    const missedTimes = timeTexts.filter((timeText) => !confirmedTimes.includes(timeText));
    log(`场地 ${courtText} 最终已选时段: ${confirmedTimes.join(" / ")}`);
    if (missedTimes.length > 0) {
      log(`场地 ${courtText} 未选中的时段: ${missedTimes.join(" / ")}，继续提交已选中的时段。`);
    }
    pickedSlotSummary = { courtText, timeTexts: confirmedTimes };
    break;
  }

  if (!pickedSlotSummary) {
    throw new Error("没能确认任何一个目标时段已被选中，请先用 inspect 模式看下当前页面文本结构。");
  }

  if (!preparedState.companionsReady || !preparedState.phoneReady || !preparedState.agreeReady) {
    const stageResult = await fillReservationAncillaryFields(page, config, { stageLabel: "补填" });
    preparedState.companionsReady = preparedState.companionsReady || stageResult.companionsReady;
    preparedState.phoneReady = preparedState.phoneReady || stageResult.phoneReady;
    preparedState.agreeReady = preparedState.agreeReady || stageResult.agreeReady;
  } else {
    log("同伴、手机号和预约须知已在预热阶段完成，本轮直接提交。");
  }

  if (config.stopBeforeSubmit) {
    log("测试模式已开启：到提交前停止。请检查当前页面上的日期、场地、同伴、手机号和勾选状态。");
    return;
  }

  // 并发模式：若已成功提交次数达到上限，本标签页放弃，避免重复下单
  if (typeof config._stopped === "function" && config._stopped()) {
    log("已达到最大成功提交数，本标签页放弃提交。");
    return;
  }

  // 提交按钮可能需要重试（首次点击后未触发验证码说明点击无效）
  let captchaFound = false;
  for (let submitAttempt = 1; submitAttempt <= 5; submitAttempt++) {
    log(`尝试点击提交（第 ${submitAttempt} 次）。`);
    await saveDebugScreenshot(page, `before-submit-attempt${submitAttempt}`, config).catch(() => {});
    const submitLabel = config.submitText || "提交";
    let submitTriggered = await clickText(page, submitLabel, { exact: true, prefer: "lowest" });
    if (!submitTriggered) {
      const btn = page.locator(`button, [type="submit"], .ivu-btn`).filter({ hasText: new RegExp(`^${submitLabel}$`) }).last();
      const btnCount = await btn.count();
      if (btnCount > 0) {
        log(`使用 Playwright locator 点击提交按钮。`);
        await waitForUiIdle(page, {
          timeoutMs: 1200,
          intervalMs: 100,
          stableRounds: 1,
        }).catch(() => {});
        submitTriggered = await btn.click({ force: true }).then(() => true).catch(() => false);
      } else {
        log("当前页面还没有稳定到可点击提交，稍后重试。");
      }
    }

    if (!submitTriggered) {
      if (submitAttempt === 5) {
        throw new Error("多次尝试后仍没有成功点击提交按钮。");
      }
      await page.waitForTimeout(300);
      continue;
    }

    const outcome = await waitForSubmitOutcome(page, config, 5000);
    await saveDebugScreenshot(page, `after-submit-attempt${submitAttempt}`, config).catch(() => {});
    if (outcome.state === "captcha") {
      captchaFound = true;
      break;
    }
    if (outcome.state === "navigated") {
      log("提交后页面已跳转，等待后续流程。");
      captchaFound = false;
      break;
    }
    if (outcome.state === "bad-data") {
      log(`第 ${submitAttempt} 次点击提交后页面进入异常返回，本轮不继续追点，等待重试。`);
    } else {
      log(`第 ${submitAttempt} 次点击提交后页面仍未稳定触发提交，将重试。`);
    }
    await page.waitForTimeout(500);
  }

  if (captchaFound) {
    log("检测到验证码，尝试自动识别...");
    const solved = config.captchaSolver === "gemini"
      ? await solveCaptchaWithGemini(page, config)
      : config.captchaSolver === "ddddocr"
        ? await solveCaptchaWithDdddocr(page, config)
        : await solveCaptchaWithChaojiying(page, config);
    if (!solved) {
      log("请在浏览器里手动完成点击验证，脚本会等待弹窗消失。");
      await page.waitForFunction(
        (captchaPromptText) => {
          const bodyText = document.body.innerText || document.body.textContent || "";
          return !bodyText.includes(captchaPromptText);
        },
        config.captchaPromptText,
        { timeout: config.captchaWaitTimeoutMs || 180000 },
      );
    }
    log("验证码弹窗已消失，继续等待跳转。");
  }

  await page.waitForTimeout(config.postCaptchaWaitMs ?? 500);
  log(`当前页面: ${page.url()}`);

  await page.waitForTimeout(config.finalStateWaitTimeoutMs ?? 2500);
}

async function runConcurrentReserve(context, config, args, initialPage) {
  const concurrency = getConfiguredConcurrency(config);
  const actualN = Math.min(concurrency, Math.max(config.slotPreferences.length, 1));
  // 若 slotPreferences 数量不足 concurrency，循环复用（多个 tab 抢同一场地提高验证码通过概率）
  const slots = Array.from({ length: actualN }, (_, i) => config.slotPreferences[i % config.slotPreferences.length]);
  const slotUrls = slots.map((slot) => getSlotReservationUrl(slot, config.url) || config.url);
  const preparedStates = [];

  log(`并发模式启动: ${actualN} 个标签页 → ${slots.map((slot) => formatSlotPreference(slot)).join(" | ")}`);

  // 共享计数器：成功提交达到 maxSuccess 次后，其他 tab 不再提交
  const maxSuccess = config.maxSuccess ?? 2;
  let successCount = 0;
  const isStopped = () => successCount >= maxSuccess;
  const markStopped = () => { successCount++; };

  // 1. 第一个标签页沿用当前页面
  const pages = [initialPage];
  if (!sameReservationUrl(initialPage.url(), slotUrls[0])) {
    await workerStorage.run(workerLogTag(config, 0), async () => {
      log(`切换到场地页面: ${slotUrls[0]}`);
      await initialPage.goto(slotUrls[0], { waitUntil: "domcontentloaded" });
    });
  }

  // 2. 登录检查（只在第一个 tab 做，共享 profile 登录态）
  await maybeLogin(pages[0], args);

  // 3. 依次打开并预热各标签页，避免同时加载导致页面异常
  preparedStates[0] = await workerStorage.run(workerLogTag(config, 0), async () =>
    warmupReservation(pages[0], { ...config, url: slotUrls[0], slotPreferences: [slots[0]] })
  );

  for (let i = 1; i < actualN; i += 1) {
    const openDelayMs = getConfigDelayMs(
      config,
      "concurrentPageOpenDelayMinMs",
      "concurrentPageOpenDelayMaxMs",
      2000,
      4000,
    );
    if (openDelayMs > 0) {
      log(`等待 ${openDelayMs}ms 后打开第 ${i + 1} 个标签页: ${formatSlotPreference(slots[i])}`);
      await sleep(openDelayMs);
    }

    const page = await context.newPage();
    pages[i] = page;
    preparedStates[i] = await workerStorage.run(workerLogTag(config, i), async () => {
      if (!sameReservationUrl(page.url(), slotUrls[i])) {
        log(`打开页面: ${slotUrls[i]}`);
        await page.goto(slotUrls[i], { waitUntil: "domcontentloaded" });
      }
      return warmupReservation(page, { ...config, url: slotUrls[i], slotPreferences: [slots[i]] });
    });
  }

  // 4. 等待开放时间（统一等待，之后各 tab 同时出发）
  await waitUntilRelease(config.releaseTime);
  await sleep(200); // 给页面一个很短的 release 后缓冲，再进入抢号阶段

  // 5+6. 各 tab 独立流水线：找到目标日期后立即开始抢号，不等其他 tab
  const results = await Promise.allSettled(
    pages.map((page, i) =>
      workerStorage.run(workerLogTag(config, i), async () => {
        const startDelayMs = getConfigDelayMs(
          config,
          "concurrentReleaseStartDelayMinMs",
          "concurrentReleaseStartDelayMaxMs",
          200,
          500,
        );
        if (startDelayMs > 0) {
          log(`开抢前等待 ${startDelayMs}ms。`);
          await sleep(startDelayMs);
        }
        const didHardReload = await findTargetDateAfterRelease(page, config);
        if (didHardReload) {
          // 整页 reload 后表单预填数据已丢失，重置标志让 reserve() 重新填写
          preparedStates[i] = { companionsReady: false, phoneReady: false, agreeReady: false };
          log("检测到整页重载，表单将在预约步骤中重新填写。");
        }
        const workerConfig = { ...config, url: slotUrls[i], slotPreferences: [slots[i]], _stopped: isStopped };
        await reserve(page, workerConfig, preparedStates[i]);
        markStopped();
        await saveDebugScreenshot(page, `after-submit-t${i + 1}`, config);
      }),
    ),
  );

  // 7. 汇总结果
  let anySuccess = false;
  results.forEach((result, i) => {
    const label = `${workerLogTag(config, i)} ${formatSlotPreference(slots[i])}`;
    if (result.status === "fulfilled") {
      log(`${label} 流程完成`);
      anySuccess = true;
    } else {
      log(`${label} 失败: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  });

  if (!anySuccess) {
    process.exitCode = 1;
  }
}

function selectAccountConfigs(config, args) {
  const hasAccounts = Array.isArray(config.accounts) && config.accounts.length > 0;
  const accounts = hasAccounts ? config.accounts : [config];

  if (args.account) {
    const target = normalizeText(args.account);
    const account = accounts.find((item) => normalizeText(item.accountName || item.name) === target);
    if (!account) {
      throw new Error(`没有找到账号配置: ${target}`);
    }
    return [account];
  }

  if (hasAccounts && (args.login || args.inspect) && !args.ocrCheck) {
    throw new Error("多账号模式下 login/inspect 请指定账号，例如 `bash run.sh login --account lys`。");
  }

  if (!hasAccounts) {
    return accounts;
  }

  const enabledAccounts = accounts.filter((account) => account.enabled !== false);
  if (enabledAccounts.length === 0) {
    throw new Error("accounts 里没有启用的账号，请把需要运行的账号 enabled 设为 true。");
  }
  return enabledAccounts;
}

async function startDdddocrPoolIfNeeded(config, args, accountConfigs) {
  if (args.login || args.inspect || config.captchaSolver !== "ddddocr") {
    return null;
  }

  const poolConfig = { ...config, accounts: accountConfigs };
  const pool = new DdddocrWorkerPool(poolConfig);
  try {
    await pool.start();
    return pool;
  } catch (error) {
    await pool.close().catch(() => {});
    const fallbackCount = Number(config.captchaDdddocrFallbackWorkerCount);
    const canFallback = Number.isFinite(fallbackCount)
      && fallbackCount > 0
      && Math.floor(fallbackCount) < pool.size;
    if (!canFallback) {
      throw error;
    }

    log(`ddddocr ${pool.size} 个 worker 启动失败，降级为 ${Math.floor(fallbackCount)} 个: ${error instanceof Error ? error.message : String(error)}`);
    const fallbackPool = new DdddocrWorkerPool({
      ...poolConfig,
      captchaDdddocrWorkerCount: Math.floor(fallbackCount),
    });
    await fallbackPool.start();
    return fallbackPool;
  }
}

async function launchContextForConfig(config, args) {
  const tag = accountLogTag(config);
  return workerStorage.run(tag, async () => {
    const lockState = await cleanupStaleProfileLocks(config.userDataDir);
    if (lockState.cleaned) {
      log("检测到上次遗留的浏览器锁文件，已自动清理。");
    }

    const configuredBrowser = config.browserExecutablePath ? await resolveBrowserExecutablePath(config) : null;
    if (configuredBrowser?.source === "config") {
      log(`使用 config.json 指定浏览器: ${configuredBrowser.executablePath}`);
    }
    if (config.disableProxy !== false) {
      log("本次浏览器进程已禁用代理（--no-proxy-server）。");
    }

    try {
      return await chromium.launchPersistentContext(
        config.userDataDir,
        buildLaunchOptions(config, args, configuredBrowser?.executablePath),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("ProcessSingleton")) {
        const processes = await listProfileProcesses(config.userDataDir);
        const pids = processes.map(extractPid).filter(Boolean);
        const pidText = pids.length > 0 ? `当前占用进程: ${pids.join(", ")}` : "没有查到活跃进程，可能是残留锁文件。";
        throw new Error(
          `浏览器 profile 正在被占用，先关闭已有的 Playwright 浏览器窗口后再重试。${pidText}`,
        );
      }

      if (!isMissingPlaywrightBrowserError(error)) {
        throw error;
      }

      const fallbackBrowser = configuredBrowser || (await resolveBrowserExecutablePath(config));
      if (!fallbackBrowser) {
        throw new Error(
          "未找到可用浏览器。请先执行 `npx playwright install chromium`，或者在 config.json 中添加 browserExecutablePath 指向本机 Chrome。",
        );
      }
      const label = fallbackBrowser.source === "config" ? "config.json 指定浏览器" : "系统浏览器";
      log(`Playwright 自带浏览器不存在，改用${label}: ${fallbackBrowser.executablePath}`);
      return chromium.launchPersistentContext(
        config.userDataDir,
        buildLaunchOptions(config, args, fallbackBrowser.executablePath),
      );
    }
  });
}

async function prepareInitialPage(context, config = {}) {
  const settleMs = config.initialPageSettleMs ?? 100;
  if (settleMs > 0) {
    await sleep(settleMs);
  }

  const restoredPages = context.pages();
  const page = restoredPages[0] || (await context.newPage());
  const extraPages = restoredPages.filter((item) => item !== page);
  if (extraPages.length > 0) {
    log(`检测到 profile 恢复了 ${extraPages.length} 个旧标签页，已关闭。`);
    await Promise.all(extraPages.map((item) => item.close({ runBeforeUnload: false }).catch(() => {})));
  }
  return page;
}

async function runAccountSession(config, args, ddddocrPool) {
  const tag = accountLogTag(config);
  return workerStorage.run(tag, async () => {
    let context;
    let page;
    const preparedState = {
      companionsReady: false,
      phoneReady: false,
      agreeReady: false,
    };
    const runUrl = resolveRunUrl(config);
    const concurrency = getConfiguredConcurrency(config);

    try {
      context = await launchContextForConfig(config, args);
      page = await prepareInitialPage(context, config);

      log(`账号并发: ${concurrency}，场地预选: ${config.slotPreferences.length} 组。`);
      log(`打开页面: ${runUrl}`);
      await page.goto(runUrl, { waitUntil: "domcontentloaded" });
      if (args.login) {
        await maybeLogin(page, { login: true });
        log("登录态已写入持久化 profile。");
        return;
      }

      await maybeLogin(page, args);
      await waitForReservationBaseReady(page);

      if (args.inspect) {
        await runInspect(page);
        return;
      }

      if (concurrency > 1) {
        await runConcurrentReserve(context, { ...config, concurrency, _ddddocrPool: ddddocrPool }, args, page);
        return;
      }

      const runConfig = { ...config, url: runUrl };
      await waitForReservationView(page, runConfig);
      const warmupResult = await warmupReservation(page, runConfig);
      preparedState.companionsReady = warmupResult.companionsReady;
      preparedState.phoneReady = warmupResult.phoneReady;
      preparedState.agreeReady = warmupResult.agreeReady;

      await waitUntilRelease(runConfig.releaseTime);
      await sleep(200);

      await findTargetDateAfterRelease(page, runConfig);

      await reserve(page, { ...runConfig, _ddddocrPool: ddddocrPool }, preparedState);
      await saveDebugScreenshot(page, "after-submit", runConfig);
    } catch (error) {
      log(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
      if (page) {
        await saveScreenshot(page, "error").catch(() => {});
      }
      process.exitCode = 1;
    } finally {
      if (context && !process.env.KEEP_BROWSER_OPEN) {
        await context.close();
      }
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const config = await readConfig();
  let ddddocrPool = null;
  try {
    const accountConfigs = selectAccountConfigs(config, args);
    ddddocrPool = await startDdddocrPoolIfNeeded(config, args, accountConfigs);
    if (args.ocrCheck) {
      log("OCR worker 检查完成，未打开浏览器。");
      return;
    }
    await Promise.all(accountConfigs.map((accountConfig) => runAccountSession(accountConfig, args, ddddocrPool)));
  } catch (error) {
    log(`执行失败: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (ddddocrPool) {
      await ddddocrPool.close().catch(() => {});
    }
  }
}

main();
