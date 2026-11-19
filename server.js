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
  settings: {
    quality: {
      type: "select",
      label: "Audio quality",
      default: "lossless",
      options: [
        { label: "Lossless / Hi-Res", value: "lossless" },
        { label: "High", value: "high" },
        { label: "Low", value: "low" }
      ]
    }
  }
};

const searchCache = new Map();
const streamCache = new Map();
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
  const order = [preferred, ...allProviders.filter((p) => p !== preferred && p.enabled && p.baseUrl)].filter(Boolean);
  for (const provider of order) {
    if (!provider.enabled || !provider.baseUrl) continue;
    try {
      let upstreamId = parsed.upstreamId;
      if (provider !== preferred) continue; // Cross-provider matching needs verified track metadata.
      const stream = await provider.resolve(upstreamId, quality);
      if (stream) return save(streamCache, cacheKey, stream);
    } catch { /* try the next eligible source */ }
  }
  return null;
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
