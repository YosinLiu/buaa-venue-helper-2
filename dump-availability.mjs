import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DOMAIN_URL = "https://cgyy.buaa.edu.cn";
const SERVER_URL = `${DOMAIN_URL}/venue-server`;
const APP_KEY = "8fceb735082b5a529312040b58ea780b";
const SIGN_SECRET = "c640ca392cd45fb3a55b00a63a86c618";

const accountName = process.argv[2] || "zd";
const targetDate = process.argv[3] || "2026-05-29";
const venueSiteId = 39;

const config = JSON.parse(await fs.readFile("config.json", "utf8"));
const account = config.accounts.find((a) => a.name === accountName);
const authPath = path.resolve(process.cwd(), `${account.userDataDir || ".playwright-profile"}-auth.json`);
const auth = JSON.parse(await fs.readFile(authPath, "utf8"));

function compact(d) { const o = {}; for (const [k,v] of Object.entries(d||{})) if (v!=null && v!=="") o[k]=v; return o; }
function sign(ts, p, d) {
  let r = `${SIGN_SECRET}${p}`;
  for (const k of Object.keys(d).sort()) if (typeof d[k] !== "object") r += `${k}${d[k]}`;
  return crypto.createHash("md5").update(r + `${ts} ${SIGN_SECRET}`).digest("hex");
}
function form(d) { const b = new URLSearchParams(); for (const [k,v] of Object.entries(d)) b.append(k, String(v)); return b.toString(); }

const ts = Date.now();
const data = compact({ venueSiteId, searchDate: targetDate, hasReserveInfo: 1, nocache: ts * 1000 + Math.floor(Math.random()*1000) });
const s = sign(ts, "/api/reservation/day/info", data);

const headers = {
  Accept: "application/json, text/plain, */*",
  "User-Agent": "Mozilla/5.0",
  Origin: DOMAIN_URL, Referer: `${DOMAIN_URL}/venue/venue-reservation/38`,
  "app-key": APP_KEY, timestamp: String(ts), sign: s,
  ...(auth.cookieHeader ? { Cookie: auth.cookieHeader } : {}),
};
if (auth.dataSixAuth) headers.cgAuthorization = auth.dataSixAuth;
if (auth.cookieCgAuthorization) { headers.cgappauthorization = auth.cookieCgAuthorization; if (!headers.cgAuthorization) headers.cgAuthorization = auth.cookieCgAuthorization; }
else if (auth.cgAuthorization) headers.cgAuthorization = auth.cgAuthorization;

const res = await fetch(`${SERVER_URL}/api/reservation/day/info?${form(data)}`, { headers });
const json = await res.json();
if (json.code !== 200) { console.log("ERROR", json); process.exit(1); }

const d = json.data;
console.log("原始响应顶层 keys:", Object.keys(d));
console.log("data 前 2000 字符:", JSON.stringify(d, null, 2).slice(0, 2000));
process.exit(0);

// 找出所有时段
const spaces = d.spaceList || d.reservationOrderJsonList || [];
console.log(`场地数: ${spaces.length}`);

// status 含义: 1=可预约, 2=已预约/已售, 3=锁单中, 4=已售完?
// 输出: 每个场地、每个时段的状态
const statusMap = { 1: "✅可订", 2: "🟡已订/锁", 3: "🔒锁单", 4: "❌售完", 5: "?5", 6: "?6" };
const courtAvailability = new Map();  // court -> [{ time, status }]
for (const sp of spaces) {
  const court = sp.spaceName || sp.venueSpaceName || sp.name;
  const times = sp.timeList || sp.spaceTimeList || [];
  for (const t of times) {
    const time = t.beginTime && t.endTime ? `${t.beginTime}-${t.endTime}` : (t.timeName || t.time);
    const st = t.status ?? t.reservationStatus;
    if (!courtAvailability.has(court)) courtAvailability.set(court, []);
    courtAvailability.get(court).push({ time, status: st, timeId: t.id || t.timeId, fee: t.orderFee });
  }
}

// 关注 14:00-15:00 和 15:00-16:00 这类晚上时段
console.log("\n=== 可订时段 (status=1) ===");
let availableCount = 0;
for (const [court, slots] of courtAvailability) {
  const open = slots.filter((s) => s.status === 1);
  if (open.length > 0) {
    console.log(`${court}: ${open.map((s) => `${s.time}[id=${s.timeId}]`).join(", ")}`);
    availableCount += open.length;
  }
}
console.log(`\n总可订时段: ${availableCount}`);

console.log("\n=== 各场地状态摘要 ===");
for (const [court, slots] of courtAvailability) {
  const summary = slots.map((s) => `${s.time}=${statusMap[s.status] || s.status}`).join(" ");
  console.log(`${court}: ${summary}`);
}
