// Dependency-free server: static page + featured-token API + token-protected admin.
// Secrets (RPC key, ADMIN_TOKEN) live only in environment variables.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RPC = process.env.SOLANA_RPC_URL || process.env.SOLAN_RPC_URL; // accepts either spelling
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const PORT = process.env.PORT || 8080;
const DATA_FILE = path.join(process.env.DATA_DIR || __dirname, "featured.json");
const REFRESH_MS = 120_000;       // featured scan refreshes at most once per 2 min, and only when a viewer asks
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

if (!RPC) console.warn("WARNING: no SOLANA_RPC_URL set");
if (!ADMIN_TOKEN) console.warn("Admin disabled: set ADMIN_TOKEN to enable /admin");
else if (ADMIN_TOKEN.length < 24) console.warn("WARNING: ADMIN_TOKEN is short; use 24+ random characters");

// ---- featured state (persisted to a file; survives restarts, not necessarily redeploys) ----
let featured = { mint: null };
try { featured = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
const saveFeatured = () => { try { fs.writeFileSync(DATA_FILE, JSON.stringify(featured)); } catch (e) { console.error("persist failed:", e.code); } };
let snapshot = null;              // {mint, t, data}
let inflight = null;

async function rpc(method, params) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!r.ok) throw new Error("RPC HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

async function scan(mint) {
  const [supply, info, largest, sigs, asset] = await Promise.all([
    rpc("getTokenSupply", [mint]),
    rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
    rpc("getTokenLargestAccounts", [mint]),
    rpc("getSignaturesForAddress", [mint, { limit: 8 }]),
    rpc("getAsset", { id: mint }).catch(() => null),   // Helius DAS; optional (name/symbol)
  ]);
  const parsed = info?.value?.data?.parsed?.info || {};
  const total = Number(supply.value.amount) || 1;
  const meta = asset?.content?.metadata || {};
  return {
    mint, name: meta.name || null, symbol: meta.symbol || asset?.token_info?.symbol || null,
    decimals: supply.value.decimals, supply: supply.value.uiAmountString,
    mintAuthority: parsed.mintAuthority ?? null, freezeAuthority: parsed.freezeAuthority ?? null,
    topAccounts: (largest.value || []).slice(0, 10).map(a => ({ address: a.address, pct: +(Number(a.amount) / total * 100).toFixed(2) })),
    recent: sigs.map(s => ({ sig: s.signature, slot: s.slot, ok: !s.err, time: s.blockTime })),
    fetchedAt: Date.now(),
  };
}

async function getFeatured() {
  if (!featured.mint) return null;
  if (snapshot && snapshot.mint === featured.mint && Date.now() - snapshot.t < REFRESH_MS) return snapshot;
  if (inflight) return inflight;                       // collapse concurrent viewers into one scan
  const mint = featured.mint;
  inflight = scan(mint).then(data => (snapshot = { mint, t: Date.now(), data }))
    .catch(e => { console.error("scan failed:", e.message); if (snapshot && snapshot.mint === mint) return snapshot; throw e; })
    .finally(() => { inflight = null; });
  return inflight;
}

// ---- admin auth ----
const fails = new Map(); // ip -> {n, until}
const ip = req => (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
function authed(req) {
  if (!ADMIN_TOKEN) return 503;
  const f = fails.get(ip(req));
  if (f && f.until > Date.now()) return 429;
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(ADMIN_TOKEN).digest();
  if (crypto.timingSafeEqual(a, b)) { fails.delete(ip(req)); return 200; }
  const n = (f?.n || 0) + 1;
  fails.set(ip(req), { n, until: n >= 8 ? Date.now() + 15 * 60_000 : 0 }); // 8 misses -> 15 min lockout
  return 401;
}

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
const body = req => new Promise((ok, no) => { let b = ""; req.on("data", c => { b += c; if (b.length > 2048) { no(new Error("too big")); req.destroy(); } }); req.on("end", () => ok(b)); });
const page = (res, file, extra = {}) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8", ...extra }); fs.createReadStream(path.join(__dirname, file)).pipe(res); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/api/featured" && req.method === "GET") {
      const s = await getFeatured().catch(() => null);
      if (!featured.mint) return send(res, 200, { none: true });
      if (!s) return send(res, 502, { error: "Upstream RPC error" });
      return send(res, 200, s.data);
    }
    if (url.pathname === "/api/admin/feature" && req.method === "POST") {
      const code = authed(req);
      if (code !== 200) return send(res, code, { error: { 503: "Admin disabled", 429: "Too many attempts", 401: "Bad token" }[code] });
      const { mint } = JSON.parse((await body(req)) || "{}");
      if (mint === "" || mint === null) { featured = { mint: null }; snapshot = null; saveFeatured(); return send(res, 200, { cleared: true }); }
      if (!B58.test(mint || "")) return send(res, 400, { error: "That doesn't look like a Solana address" });
      if (!RPC) return send(res, 500, { error: "Server RPC not configured" });
      let data; try { data = await scan(mint); } catch (e) { console.error("scan failed:", e.message); return send(res, 502, { error: "Could not read that token (is it a mint address?)" }); }
      featured = { mint }; snapshot = { mint, t: Date.now(), data }; saveFeatured();
      return send(res, 200, { ok: true, name: data.name, symbol: data.symbol, mint });
    }
    if (url.pathname === "/admin") return page(res, "admin.html", { "cache-control": "no-store", "x-robots-tag": "noindex", "x-frame-options": "DENY" });
    if (url.pathname === "/" || url.pathname === "/index.html") return page(res, "index.html");
    res.writeHead(404); res.end("Not found");
  } catch (e) { send(res, 400, { error: "Bad request" }); }
}).listen(PORT, () => console.log("listening on " + PORT));
