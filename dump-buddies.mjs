import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DOMAIN_URL = "https://cgyy.buaa.edu.cn";
const SERVER_URL = `${DOMAIN_URL}/venue-server`;
const DEFAULT_APP_KEY = "8fceb735082b5a529312040b58ea780b";
const DEFAULT_SIGN_SECRET = "c640ca392cd45fb3a55b00a63a86c618";

const accountName = process.argv[2] || "lys";
const config = JSON.parse(await fs.readFile("config.json", "utf8"));
const account = config.accounts.find((a) => a.name === accountName);
if (!account) { console.error(`未找到账号: ${accountName}`); process.exit(1); }

const authPath = path.resolve(process.cwd(), `${account.userDataDir || ".playwright-profile"}-auth.json`);
const auth = JSON.parse(await fs.readFile(authPath, "utf8"));
console.log(`使用 auth 文件: ${authPath}（保存于 ${auth.savedAt || "未知"}）`);

function compactScalarData(data) {
  const out = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

function signRequest(timestamp, apiPath, data) {
  let raw = `${DEFAULT_SIGN_SECRET}${apiPath}`;
  const clean = compactScalarData(data);
  for (const key of Object.keys(clean).sort()) {
    if (typeof clean[key] !== "object") raw += `${key}${clean[key]}`;
  }
  raw += `${timestamp} ${DEFAULT_SIGN_SECRET}`;
  return crypto.createHash("md5").update(raw).digest("hex");
}

function formEncode(data) {
  const b = new URLSearchParams();
  for (const [k, v] of Object.entries(compactScalarData(data))) b.append(k, String(v));
  return b.toString();
}

const apiPath = "/api/buddies";
const ts = Date.now();
const data = compactScalarData({ page: -1, size: -1, nocache: ts });
const sign = signRequest(ts, apiPath, data);

const headers = {
  Accept: "application/json, text/plain, */*",
  "Content-Type": "application/x-www-form-urlencoded",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Origin: DOMAIN_URL,
  Referer: `${DOMAIN_URL}/venue/venue-reservation/38`,
  "app-key": DEFAULT_APP_KEY,
  timestamp: String(ts),
  sign,
  ...(auth.cookieHeader ? { Cookie: auth.cookieHeader } : {}),
};
if (auth.dataSixAuth) headers.cgAuthorization = auth.dataSixAuth;
if (auth.cookieCgAuthorization) {
  headers.cgappauthorization = auth.cookieCgAuthorization;
  if (!headers.cgAuthorization) headers.cgAuthorization = auth.cookieCgAuthorization;
} else if (auth.cgAuthorization) {
  headers.cgAuthorization = auth.cgAuthorization;
}

const url = `${SERVER_URL}${apiPath}?${formEncode(data)}`;
const res = await fetch(url, { method: "GET", headers });
const text = await res.text();
let json = null;
try { json = JSON.parse(text); } catch {}

console.log(`HTTP ${res.status}`);
if (!json) { console.log("原始响应:", text); process.exit(0); }

console.log("接口返回:");
console.log(JSON.stringify(json, null, 2));

const d = json.data;
const list = Array.isArray(d) ? d
  : Array.isArray(d?.list) ? d.list
  : Array.isArray(d?.content) ? d.content
  : Array.isArray(d?.records) ? d.records
  : [];

console.log(`\n=== ${accountName} 的同伴名称提取 (共 ${list.length} 项) ===`);
for (const item of list) {
  const candidates = ["name", "userName", "buddyName", "realName", "nickname"]
    .map((k) => `${k}=${JSON.stringify(item?.[k])}`).join("  ");
  console.log(candidates);
}

const target = (account.companions || [])[0];
if (target) {
  const matched = list.find((it) => {
    const n = it?.name || it?.userName || it?.buddyName || it?.realName || it?.nickname;
    return n === target || (n && (n.includes(target) || target.includes(n)));
  });
  console.log(`\n配置里的 companion = "${target}"，匹配结果: ${matched ? "✅ 匹配到" : "❌ 未匹配"}`);
  if (matched) console.log(JSON.stringify(matched, null, 2));
}
