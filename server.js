// Meow Smash site + gacha control service (no dependencies).
//
// Public:
//   GET  /api/gacha        signed gacha config the game downloads ({payload, sig}, Ed25519)
//   GET  /gacha            概率公示 page (rates, current/upcoming rate-up, events, change log)
//   GET  /*                static files from ./public
// Admin (Authorization: Bearer $ADMIN_TOKEN):
//   GET  /admin            admin console (HTML)
//   GET  /api/admin/state  current settings + preview + audit log
//   POST /api/admin/state  update settings (validated, audit-logged)
//
// Env: ADMIN_TOKEN (>= 24 chars), SIGNING_KEY (Ed25519 private key, PKCS8 PEM), DATA_DIR (default /data)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || "/data";
const PUBLIC = path.join(__dirname, "public");
const CATS = JSON.parse(fs.readFileSync(path.join(PUBLIC, "cats.json"), "utf8"));
const GACHA_SSR = CATS.filter((c) => c.rarity === "SSR" && !c.exclusive).map((c) => c.id).sort();
const WEEK = 7 * 86400e3;
const BJ = 8 * 3600e3;

// ---------- settings ----------
const DEFAULTS = {
  rates: { N: 55, R: 30, SR: 12, SSR: 3 },
  pity: 40,
  rateUp: 0.5,
  guaranteeAfterMiss: true,
  autoRotate: true,
  autoMonthlyBoost: true, // last weekend of each month: SSR +1pp (taken from N)
  excludedFromRotation: [],
  overrides: [], // [{week: "2026-11-02", catId, note}]
  events: [], // [{start, end, ssrBonus, title}] ISO strings
  scheduledRates: [], // [{from, rates, pity}] future rate changes (announced ahead)
  announcement: "",
};
const BOUNDS = { SSR: [1, 10], SR: [5, 25], R: [15, 45], N: [30, 79], pity: [10, 90], rateUp: [0.5, 1], ssrBonus: [0, 3] };

function dataFile(name) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
  return path.join(DATA_DIR, name);
}
function load(name, def) {
  try { return JSON.parse(fs.readFileSync(dataFile(name), "utf8")); } catch { return def; }
}
function save(name, obj) {
  const f = dataFile(name);
  fs.writeFileSync(f + ".tmp", JSON.stringify(obj, null, 1));
  fs.renameSync(f + ".tmp", f);
}
let settings = Object.assign({}, DEFAULTS, load("settings.json", {}));
let auditLog = load("audit.json", []);

// ---------- schedule logic ----------
function weekIndex(t) { return Math.floor((t + BJ - 4 * 86400e3) / WEEK); } // weeks start Monday 00:00 Beijing
function weekStart(w) { return w * WEEK + 4 * 86400e3 - BJ; }
function isoDay(t) { return new Date(t + BJ).toISOString().slice(0, 10); }

// splitmix-ish deterministic shuffle per rotation cycle
function rng(seed) {
  let s = BigInt(seed) * 0x9e3779b97f4a7c15n + 0x632be59bd9b4e019n;
  return () => {
    s = (s + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return Number((z ^ (z >> 31n)) % 1000000n) / 1000000;
  };
}
function cycleOrder(c, pool) {
  const r = rng(c + 1);
  const a = pool.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function autoCat(w) {
  const pool = GACHA_SSR.filter((id) => !settings.excludedFromRotation.includes(id));
  if (!pool.length) return GACHA_SSR[0];
  const n = pool.length, c = Math.floor(w / n), pos = w % n;
  const order = cycleOrder(c, pool);
  // avoid the same cat twice in a row across cycle boundaries
  if (n > 1) { const prev = cycleOrder(c - 1, pool); if (order[0] === prev[n - 1]) [order[0], order[1]] = [order[1], order[0]]; }
  return order[pos];
}
function bannerFor(w) {
  const day = isoDay(weekStart(w));
  const o = settings.overrides.find((x) => x.week === day);
  if (o && GACHA_SSR.includes(o.catId)) return { start: weekStart(w), end: weekStart(w + 1), catId: o.catId, note: o.note || "", source: "manual" };
  return { start: weekStart(w), end: weekStart(w + 1), catId: settings.autoRotate ? autoCat(w) : GACHA_SSR[0], note: "", source: "auto" };
}
function lastWeekendOfMonth(t) {
  const d = new Date(t + BJ);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  const last = new Date(Date.UTC(y, m + 1, 0));
  const dow = last.getUTCDay(); // 0 Sun
  const sun = new Date(Date.UTC(y, m + 1, 0 - ((dow + 7) % 7)));
  const sat = new Date(sun.getTime() - 86400e3);
  return { start: sat.getTime() - BJ, end: sun.getTime() + 86400e3 - BJ };
}
function events(now) {
  const out = settings.events.map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end), ssrBonus: e.ssrBonus, title: e.title, source: "manual" }));
  if (settings.autoMonthlyBoost) {
    for (const k of [0, 1]) {
      const d = new Date(now + BJ); d.setUTCMonth(d.getUTCMonth() + k, 1);
      const w = lastWeekendOfMonth(d.getTime() - BJ);
      out.push({ start: w.start, end: w.end, ssrBonus: 1, title: "月末狂欢：SSR 概率 +1%", source: "auto" });
    }
  }
  return out.filter((e) => e.end > now - 86400e3).sort((a, b) => a.start - b.start);
}
function ratesAt(t) {
  let r = { rates: settings.rates, pity: settings.pity };
  for (const s of settings.scheduledRates.slice().sort((a, b) => Date.parse(a.from) - Date.parse(b.from))) {
    if (Date.parse(s.from) <= t) r = { rates: s.rates, pity: s.pity ?? r.pity };
  }
  return r;
}
function publicConfig(now = Date.now()) {
  const w = weekIndex(now);
  const banners = [];
  for (let i = -1; i <= 8; i++) banners.push(bannerFor(w + i));
  const cur = ratesAt(now);
  return {
    version: 1,
    issuedAt: now,
    validUntil: now + 14 * 86400e3,
    rates: cur.rates,
    pity: cur.pity,
    rateUp: settings.rateUp,
    guaranteeAfterMiss: settings.guaranteeAfterMiss,
    scheduledRates: settings.scheduledRates.filter((s) => Date.parse(s.from) > now).map((s) => ({ from: Date.parse(s.from), rates: s.rates, pity: s.pity ?? cur.pity })),
    banners,
    events: events(now),
    announcement: settings.announcement || "",
    disclosureUrl: "/gacha",
  };
}

// ---------- signing ----------
let signKey = null;
if (process.env.SIGNING_KEY) {
  try { signKey = crypto.createPrivateKey(process.env.SIGNING_KEY.replace(/\\n/g, "\n")); } catch (e) { console.error("bad SIGNING_KEY", e.message); }
}
if (!signKey) {
  // First boot: create an Ed25519 key and keep it on the persistent volume. Only the public key is ever exposed.
  const f = dataFile("signing_key.pem");
  try {
    if (!fs.existsSync(f)) {
      const { privateKey } = crypto.generateKeyPairSync("ed25519");
      fs.writeFileSync(f, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    }
    signKey = crypto.createPrivateKey(fs.readFileSync(f, "utf8"));
  } catch (e) { console.error("signing key unavailable", e.message); }
}
const PUBLIC_KEY_B64 = signKey ? crypto.createPublicKey(signKey).export({ type: "spki", format: "der" }).subarray(-32).toString("base64") : "";
function signed(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString("base64");
  const sig = signKey ? crypto.sign(null, Buffer.from(payload), signKey).toString("base64") : "";
  return { payload, sig };
}

// ---------- validation ----------
function inRange(v, [a, b]) { return typeof v === "number" && isFinite(v) && v >= a && v <= b; }
function validRates(r) {
  if (!r) return "rates missing";
  for (const k of ["N", "R", "SR", "SSR"]) if (!inRange(r[k], BOUNDS[k])) return `${k} must be within ${BOUNDS[k].join("–")}%`;
  if (Math.abs(r.N + r.R + r.SR + r.SSR - 100) > 0.001) return "rates must sum to 100";
  return null;
}
function playerWorse(a, b) { // is b worse than a for players?
  return b.rates.SSR < a.rates.SSR || b.rates.SR < a.rates.SR || (b.pity ?? a.pity) > a.pity;
}
function validate(next, prev) {
  const e = validRates(next.rates); if (e) return e;
  if (!inRange(next.pity, BOUNDS.pity)) return "pity out of range";
  if (!inRange(next.rateUp, BOUNDS.rateUp)) return "rateUp out of range";
  // Changes that are worse for players may not take effect immediately: schedule ≥72h ahead instead.
  if (playerWorse({ rates: prev.rates, pity: prev.pity }, { rates: next.rates, pity: next.pity })) return "降低概率/提高保底必须通过「预约变更」至少提前 72 小时公示";
  for (const s of next.scheduledRates || []) {
    const er = validRates(s.rates); if (er) return "scheduled: " + er;
    const from = Date.parse(s.from);
    if (!isFinite(from)) return "scheduled: bad date";
    if (s.pity != null && !inRange(s.pity, BOUNDS.pity)) return "scheduled: pity out of range";
    const isNew = !(prev.scheduledRates || []).some((p) => p.from === s.from);
    if (isNew && playerWorse({ rates: next.rates, pity: next.pity }, s) && from < Date.now() + 72 * 3600e3) return "不利于玩家的预约变更需至少提前 72 小时";
  }
  for (const o of next.overrides || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(o.week)) return "override week must be YYYY-MM-DD (Monday)";
    if (!GACHA_SSR.includes(o.catId)) return `unknown SSR cat ${o.catId}`;
  }
  for (const ev of next.events || []) {
    if (!isFinite(Date.parse(ev.start)) || !isFinite(Date.parse(ev.end)) || Date.parse(ev.end) <= Date.parse(ev.start)) return "event dates invalid";
    if (!inRange(ev.ssrBonus, BOUNDS.ssrBonus)) return "event ssrBonus must be 0–3";
    if (Date.parse(ev.end) - Date.parse(ev.start) > 14 * 86400e3) return "event longer than 14 days";
  }
  for (const id of next.excludedFromRotation || []) if (!GACHA_SSR.includes(id)) return `unknown cat ${id}`;
  if ((next.excludedFromRotation || []).length >= GACHA_SSR.length) return "cannot exclude every SSR";
  if ((next.announcement || "").length > 280) return "announcement too long";
  return null;
}

// ---------- auth ----------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const attempts = new Map();
function authed(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now();
  const a = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60e3);
  if (a.length >= 8) return { ok: false, ip, locked: true };
  const h = req.headers.authorization || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const ok = ADMIN_TOKEN.length >= 24 && tok.length === ADMIN_TOKEN.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(ADMIN_TOKEN));
  if (!ok) { a.push(now); attempts.set(ip, a); }
  return { ok, ip };
}

// ---------- http ----------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };
const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
function send(res, code, body, type = "application/json", extra = {}) {
  res.writeHead(code, Object.assign({ "Content-Type": type }, SEC, extra));
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > 64e3) { bad(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    req.on("error", bad);
  });
}
function serveStatic(req, res, p) {
  let file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) return send(res, 403, "forbidden", "text/plain");
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
  if (!fs.existsSync(file) && fs.existsSync(file + ".html")) file += ".html";
  if (!fs.existsSync(file)) return send(res, 404, "not found", "text/plain");
  send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || "application/octet-stream", { "Cache-Control": "public, max-age=300" });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/gacha" && req.method === "GET") {
      return send(res, 200, signed(publicConfig()), "application/json", { "Cache-Control": "public, max-age=300", "Access-Control-Allow-Origin": "*" });
    }
    if (url.pathname === "/api/cats") return send(res, 200, CATS);
    if (url.pathname === "/api/pubkey") return send(res, 200, { ed25519: PUBLIC_KEY_B64 });
    if (url.pathname === "/api/public") return send(res, 200, { config: publicConfig(), log: auditLog.slice(-30).map(({ ip, ...r }) => r) });
    if (url.pathname === "/gacha") return serveStatic(req, res, "/gacha.html");
    if (url.pathname === "/admin") return serveStatic(req, res, "/admin.html");
    if (url.pathname === "/api/admin/state") {
      const a = authed(req);
      if (a.locked) return send(res, 429, { error: "too many attempts, wait 10 minutes" });
      if (!a.ok) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET") {
        return send(res, 200, { settings, preview: publicConfig(), log: auditLog.slice(-100), ssrPool: GACHA_SSR, signing: !!signKey });
      }
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req));
        const next = Object.assign({}, settings, body.settings || {});
        const err = validate(next, settings);
        if (err) return send(res, 400, { error: err });
        const before = settings;
        settings = next;
        save("settings.json", settings);
        auditLog.push({ at: new Date().toISOString(), ip: a.ip, summary: String(body.summary || "更新设置").slice(0, 200),
          changes: Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k])) });
        auditLog = auditLog.slice(-500);
        save("audit.json", auditLog);
        return send(res, 200, { ok: true, preview: publicConfig() });
      }
    }
    if (url.pathname === "/healthz") return send(res, 200, { ok: true });
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    return send(res, 400, { error: String(e.message || e).slice(0, 200) });
  }
}).listen(PORT, () => console.log(`meowsmash site on :${PORT}, data=${DATA_DIR}, signing=${!!signKey}, admin=${ADMIN_TOKEN.length >= 24}`));
