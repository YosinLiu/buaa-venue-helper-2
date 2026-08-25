// 捕获真实浏览器从页面加载到 order/submit 的完整 API 调用序列
// 用法: node capture-submit.mjs
// 打开浏览器后，手动选择场地、完成验证码并提交（或只到验证码通过即可）
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import path from "node:path";

const cfg = JSON.parse(readFileSync("config.json", "utf8"));
const account = cfg.accounts.find((a) => a.name === "lys");
const userDataDir = path.resolve(account.userDataDir);
const viewport = account.viewport || { width: 1280, height: 800 };

const context = await chromium.launchPersistentContext(userDataDir, {
  executablePath: cfg.browserExecutablePath,
  headless: false,
  viewport: null,
  args: ["--start-maximized"],
});

const page = await context.newPage();

// ── 过滤响应体：去掉 base64 图片，保留关键字段 ──────────────────────────────
function summarizeBody(body) {
  if (!body) return null;
  const str = JSON.stringify(body);
  // 去掉 base64 值
  const cleaned = str.replace(/"(originalImageBase64|jigsawImageBase64|shadeImage)":\s*"[^"]{20,}"/g, '"$1":"<base64>"');
  try { return JSON.parse(cleaned); } catch { return body; }
}

// ── 时间轴记录 ──────────────────────────────────────────────────────────────
const t0 = Date.now();
const callLog = [];  // { dt, phase:"req"|"resp", path, method?, headers?, body?, status? }

page.on("request", (req) => {
  const url = req.url();
  if (!url.includes("/api/")) return;
  const pathname = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  const entry = {
    dt: Date.now() - t0,
    phase: "→ REQ",
    path: pathname,
    method: req.method(),
  };
  // 请求头（只保留业务相关头）
  const h = req.headers();
  const relevantHeaders = {};
  for (const k of ["app-key", "timestamp", "sign", "cgauthorization", "cgappauthorization", "cookie", "content-type", "origin", "referer", "user-agent"]) {
    if (h[k]) relevantHeaders[k] = k === "cookie" ? h[k].slice(0, 80) + (h[k].length > 80 ? "…" : "") : h[k];
  }
  entry.headers = relevantHeaders;
  // 请求体（GET → query params）
  if (req.method() === "POST") {
    entry.body = req.postData();
  } else {
    try {
      const params = Object.fromEntries(new URL(url).searchParams.entries());
      if (Object.keys(params).length) entry.queryParams = params;
    } catch {}
  }
  callLog.push(entry);
  console.log(`[+${String(entry.dt).padStart(6)}ms] → ${req.method()} ${pathname}`);
  if (entry.body) {
    // 解析 form-encoded body，过滤 base64
    try {
      const params = Object.fromEntries(new URLSearchParams(entry.body));
      const filtered = {};
      for (const [k, v] of Object.entries(params)) {
        filtered[k] = v.length > 80 ? v.slice(0, 80) + "…" : v;
      }
      console.log("    body:", JSON.stringify(filtered));
    } catch {
      console.log("    body:", entry.body.slice(0, 200));
    }
  }
  if (entry.queryParams) {
    console.log("    query:", JSON.stringify(entry.queryParams));
  }
});

page.on("response", async (resp) => {
  const url = resp.url();
  if (!url.includes("/api/")) return;
  const pathname = (() => { try { return new URL(url).pathname; } catch { return url; } })();
  const dt = Date.now() - t0;
  let body = null;
  try { body = await resp.json(); } catch {}
  const summarized = summarizeBody(body);
  const entry = { dt, phase: "← RESP", path: pathname, status: resp.status(), body: summarized };
  callLog.push(entry);
  console.log(`[+${String(dt).padStart(6)}ms] ← ${resp.status()} ${pathname}`);
  if (summarized) {
    const str = JSON.stringify(summarized);
    console.log("    resp:", str.length > 400 ? str.slice(0, 400) + "…" : str);
  }
});

console.log("═══════════════════════════════════════════════════════════════");
console.log("请手动操作浏览器：选择场地 → 点击提交 → 完成验证码 → 确认提交");
console.log("脚本将在 order/submit 完成后（或 180s 超时后）自动打印分析结果");
console.log("═══════════════════════════════════════════════════════════════");
await page.goto(cfg.url, { waitUntil: "domcontentloaded" });

// ── 等待 order/submit 响应 ─────────────────────────────────────────────────
let submitResp = null;
page.on("response", async (resp) => {
  if (resp.url().includes("/api/reservation/order/submit")) {
    try { submitResp = await resp.json(); } catch { submitResp = {}; }
  }
});

await new Promise((resolve) => {
  const check = setInterval(() => {
    if (submitResp !== null) { clearInterval(check); resolve(); }
  }, 500);
  setTimeout(() => { clearInterval(check); resolve(); }, 180000);
});

// ── 汇总分析 ───────────────────────────────────────────────────────────────
console.log("\n\n══════════════ 完整调用时间轴 ══════════════");
const reqEntries = callLog.filter((e) => e.phase === "→ REQ");
for (const e of reqEntries) {
  console.log(`  [+${String(e.dt).padStart(6)}ms] ${e.method} ${e.path}`);
}

console.log("\n══════════════ 发现的接口（去重）══════════════");
const seenPaths = [...new Set(reqEntries.map((e) => e.path))];
const scriptKnownPaths = new Set([
  "/api/captcha/get",
  "/api/captcha/check",
  "/api/buddies",
  "/api/reservation/day/info",
  "/api/reservation/order/submit",
]);
for (const p of seenPaths) {
  const isNew = !scriptKnownPaths.has(p);
  console.log(`  ${isNew ? "★ 新接口" : "  已知"} ${p}`);
}

console.log("\n══════════════ order/submit 字段对比 ══════════════");
const submitReq = callLog.find((e) => e.phase === "→ REQ" && e.path.includes("/order/submit"));
if (submitReq?.body) {
  const params = new URLSearchParams(submitReq.body);
  const scriptFields = new Set([
    "venueSiteId", "reservationDate", "weekStartDate", "reservationOrderJson",
    "reservationType", "phone", "orderPin", "orderPrice", "buddyIds",
    "captchaVerification", "captchaToken", "timestamp", "sign", "nocache",
  ]);
  const extra = [];
  const all = [];
  for (const [k] of params) {
    const v = params.get(k);
    all.push(`${k}=${v?.length > 60 ? v.slice(0, 60) + "…" : v}`);
    if (!scriptFields.has(k)) extra.push(`★ ${k}=${v?.length > 60 ? v.slice(0, 60) + "…" : v}`);
  }
  console.log("浏览器提交的全部字段:");
  all.forEach((s) => console.log(`  ${s}`));
  console.log("");
  if (extra.length) {
    console.log("脚本缺少的字段（★）:");
    extra.forEach((s) => console.log(`  ${s}`));
  } else {
    console.log("字段齐全，无额外字段");
  }
} else {
  console.log("未捕获到 order/submit 请求体");
}

console.log("\n══════════════ order/submit 响应 ══════════════");
if (submitResp) {
  console.log(JSON.stringify(submitResp, null, 2));
}

// ── 各接口详细请求头（打印请求头差异，聚焦 order/submit） ───────────────────
console.log("\n══════════════ order/submit 请求头 ══════════════");
if (submitReq?.headers) {
  console.log(JSON.stringify(submitReq.headers, null, 2));
}

// ── 所有发现的响应体 token 字段 ────────────────────────────────────────────
console.log("\n══════════════ 各接口响应中出现的 token 字段 ══════════════");
const respEntries = callLog.filter((e) => e.phase === "← RESP");
for (const e of respEntries) {
  const str = JSON.stringify(e.body || {});
  const tokenMatches = [...str.matchAll(/"([^"]*[Tt]oken[^"]*)":\s*"([^"]{8,})"/g)];
  if (tokenMatches.length) {
    console.log(`  ${e.path}:`);
    for (const m of tokenMatches) {
      console.log(`    ${m[1]} = ${m[2].slice(0, 60)}${m[2].length > 60 ? "…" : ""}`);
    }
  }
}

await context.close();
