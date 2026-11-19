import http from "node:http";
import { createBitChordAuth } from "./src/auth.js";
import { allProviders, findProvider, providerStatus } from "./src/providers/index.js";
import { dedupeTracks, unpackTrackId } from "./src/normalize.js";

const port = Number(process.env.PORT || 10000);
const hostList = (process.env.BITCHORD_HOSTS || process.env.RENDER_EXTERNAL_HOSTNAME || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const auth = createBitChordAuth({ hosts: hostList });

const manifest = {
  id: "dev.multisource.bitchord",
  name: "MultiSource BitChord",
  version: "1.0.0",
  description: "Aggregated music search with provider failover.",
  resources: ["search", "stream"],
  bitchordAuth: true,
  allowDownloads: 1,
  settings: [
    {
      key: "quality",
      type: "select",
      label: "Audio quality",
      default: "lossless",
      options: [
        { label: "Lossless / Hi-Res", value: "lossless" },
        { label: "High", value: "high" },
        { label: "Low", value: "low" }
      ]
    }
  ]
};

const searchCache = new Map();
const streamCache = new Map();
const trackMetadata = new Map();
const TTL = 5 * 60 * 1000;

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "X-BitChord-Token, X-BitChord-Proof, Content-Type",
    "access-control-expose-headers": "WWW-Authenticate",
    ...extra
  });
  res.end(JSON.stringify(body));
}
function cached(map, key) {
  const item = map.get(key);
  if (!item || item.expires < Date.now()) { map.delete(key); return undefined; }
  return item.value;
}
function save(map, key, value) {
  map.set(key, { value, expires: Date.now() + TTL });
  if (map.size > 1000) map.delete(map.keys().next().value);
  return value;
}

async function searchAll(query, quality) {
  const key = `${quality}:${query.toLowerCase()}`;
  const hit = cached(searchCache, key);
  if (hit) return hit;
  const settled = await Promise.allSettled(allProviders.filter((p) => p.enabled && p.baseUrl).map(async (provider) => ({
    provider, tracks: await provider.search(query, quality)
  })));
  const tracks = [];
  const sources = {};
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    const { provider, tracks: rows } = result.value;
    sources[provider.id] = rows.length;
    for (const row of rows) trackMetadata.set(row.id, { title: row.title, artist: row.artist, duration: row.duration || 0 });
    tracks.push(...rows);
  }
  const combined = dedupeTracks(tracks);
  return save(searchCache, key, { tracks: combined, sources });
}

async function resolveTrack(encodedId, quality) {
  const parsed = unpackTrackId(encodedId);
  if (!parsed) return null;
  const cacheKey = `${encodedId}:${quality}`;
  const hit = cached(streamCache, cacheKey);
  if (hit) return hit;
  const preferred = findProvider(parsed.providerId);
  if (preferred?.enabled && preferred.baseUrl) {
    try {
      const stream = await preferred.resolve(parsed.upstreamId, quality);
      if (stream) return save(streamCache, cacheKey, stream);
    } catch { /* fall through to other providers */ }
  }
  const metadata = trackMetadata.get(encodedId);
  if (!metadata?.title) return null;
  const query = [metadata.artist, metadata.title].filter(Boolean).join(" ");
  const alternatives = allProviders.filter((p) => p !== preferred && p.enabled && p.baseUrl);
  const searches = await Promise.allSettled(alternatives.map(async (provider) => ({ provider, rows: await provider.search(query, quality) })));
  const candidates = [];
  for (const result of searches) {
    if (result.status !== "fulfilled") continue;
    for (const row of result.value.rows) {
      const titleScore = similarity(row.title, metadata.title);
      const artistScore = similarity(row.artist, metadata.artist);
      const delta = metadata.duration && row.duration ? Math.abs(metadata.duration - row.duration) : 0;
      if (titleScore < 0.92 || (metadata.artist && artistScore < 0.55) || delta > 12) continue;
      candidates.push({ provider: result.value.provider, row, score: titleScore * 60 + artistScore * 30 - delta });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const candidate of candidates) {
    try {
      const stream = await candidate.provider.resolve(candidate.row._upstreamId, quality);
      if (stream) return save(streamCache, cacheKey, stream);
    } catch { /* try the next candidate */ }
  }
  return null;
}

function similarity(a, b) {
  const clean = (value) => String(value || "").toLowerCase().normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const left = clean(a);
  const right = clean(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const aWords = new Set(left.split(" "));
  const bWords = new Set(right.split(" "));
  return [...aWords].filter((word) => bWords.has(word)).length / Math.max(aWords.size, bWords.size);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" }, { allow: "GET, OPTIONS" });
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/manifest.json") return json(res, 200, manifest);

  const verified = await auth.verify(req.headers);
  if (!verified.ok) {
    const refusal = auth.refusal(verified);
    return json(res, refusal.status, await refusal.json(), Object.fromEntries(refusal.headers));
  }
  if (path === "/health") return json(res, 200, { ok: true, providers: providerStatus() });
  if (path === "/search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) return json(res, 200, { tracks: [] });
    try {
      const result = await searchAll(query, url.searchParams.get("quality") || "lossless");
      return json(res, 200, { tracks: result.tracks });
    } catch (error) {
      return json(res, 502, { error: "search_failed", message: String(error.message || error), tracks: [] });
    }
  }
  if (path.startsWith("/stream/")) {
    const id = decodeURIComponent(path.slice("/stream/".length));
    const stream = await resolveTrack(id, url.searchParams.get("quality") || "lossless");
    return stream ? json(res, 200, stream) : json(res, 404, { error: "stream_not_found" });
  }
  return json(res, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0", () => console.log(`MultiSource BitChord listening on :${port}; auth hosts: ${hostList.join(", ")}`));
