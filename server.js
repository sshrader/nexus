// Tiny dependency-free server: serves index.html + one on-demand API route.
// The Helius key lives only in the environment and is never sent to the browser.
const http = require("http");
const fs = require("fs");
const path = require("path");

const RPC = process.env.SOLANA_RPC_URL || process.env.SOLAN_RPC_URL; // accepts either spelling
const PORT = process.env.PORT || 8080;
const CACHE_MS = 60_000;          // same mint is served from cache for 60s
const MAX_SCANS_PER_MIN = 15;     // global cap, protects the free tier
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const cache = new Map();          // mint -> {t, data}
let windowStart = Date.now(), scans = 0;

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!r.ok) throw new Error("RPC HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

async function scan(mint) {
  const [supply, info, largest, sigs] = await Promise.all([
    rpc("getTokenSupply", [mint]),
    rpc("getAccountInfo", [mint, { encoding: "jsonParsed" }]),
    rpc("getTokenLargestAccounts", [mint]),
    rpc("getSignaturesForAddress", [mint, { limit: 8 }]),
  ]);
  const parsed = info?.value?.data?.parsed?.info || {};
  const total = Number(supply.value.amount) || 1;
  return {
    mint,
    decimals: supply.value.decimals,
    supply: supply.value.uiAmountString,
    mintAuthority: parsed.mintAuthority ?? null,     // null = renounced
    freezeAuthority: parsed.freezeAuthority ?? null, // null = none
    topAccounts: (largest.value || []).slice(0, 10).map(a => ({
      address: a.address,
      pct: +(Number(a.amount) / total * 100).toFixed(2),
    })),
    recent: sigs.map(s => ({ sig: s.signature, slot: s.slot, ok: !s.err, time: s.blockTime })),
    fetchedAt: Date.now(),
  };
}

const send = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/api/token") {
    if (!RPC) return send(res, 500, { error: "Server RPC not configured" });
    const mint = url.searchParams.get("mint") || "";
    if (!B58.test(mint)) return send(res, 400, { error: "That doesn't look like a Solana address" });
    const hit = cache.get(mint);
    if (hit && Date.now() - hit.t < CACHE_MS) return send(res, 200, { ...hit.data, cached: true });
    if (Date.now() - windowStart > 60_000) { windowStart = Date.now(); scans = 0; }
    if (++scans > MAX_SCANS_PER_MIN) return send(res, 429, { error: "Scan limit reached, try again in a minute" });
    try {
      const data = await scan(mint);
      cache.set(mint, { t: Date.now(), data });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
      return send(res, 200, data);
    } catch (e) {
      console.error("scan failed:", e.message);           // never log the URL/key
      return send(res, 502, { error: "Upstream RPC error" });
    }
  }
  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }
  res.writeHead(404); res.end("Not found");
}).listen(PORT, () => console.log("listening on " + PORT + (RPC ? "" : " (NO RPC URL SET)")));
