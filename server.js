import { readFileSync } from "node:fs";
import http from "node:http";
import { createBitChordAuth } from "./src/auth.js";
import { allProviders, findProvider, isProviderAvailable, providerStatus } from "./src/providers/index.js";
import { audioResolutionScore, dedupeTracks, searchRelevanceScore, trackMatchScore, unpackTrackId } from "./src/normalize.js";

const port = Number(process.env.PORT || 10000);
const hostList = (process.env.BITCHORD_HOSTS || process.env.RENDER_EXTERNAL_HOSTNAME || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const auth = createBitChordAuth({ hosts: hostList });
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

const searchCache = new Map();
const streamCache = new Map();
const trackMetadata = new Map();
const searchInflight = new Map();
const streamInflight = new Map();
const SEARCH_TTL = 3 * 60 * 1000;
const STREAM_TTL = 45 * 1000;
const PROVIDER_RESPONSE_WINDOW_MS = 9000;

function withinDeadline(promise, deadline, label = "provider response window expired") {
  const remaining = Math.max(0, deadline - Date.now());
  if (!remaining) return Promise.reject(new Error(label));
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), remaining); })
  ]).finally(() => clearTimeout(timer));
}

function json(res, status, body, extra = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "X-BitChord-Token, X-BitChord-Proof, Content-Type",
    "access-control-expose-headers": "WWW-Authenticate, X-Addon-Sources",
    ...extra
  });
  res.end(JSON.stringify(body, null, 2));
}
function cached(map, key) {
  const item = map.get(key);
  if (!item || item.expires < Date.now()) { map.delete(key); return undefined; }
  return item.value;
}
function save(map, key, value, ttl) {
  map.set(key, { value, expires: Date.now() + ttl });
  if (map.size > 1000) map.delete(map.keys().next().value);
  return value;
}
function cleanQuality(value) {
  return ["lossless", "high", "low"].includes(String(value || "").toLowerCase())
    ? String(value).toLowerCase()
    : "lossless";
}
function cleanAtmos(value) {
  return value === "auto" ? "auto" : "stereo";
}

async function searchProviderSet(providers, query, quality, atmos, authHeaders) {
  const eligible = providers.filter(isProviderAvailable);
  const deadline = Date.now() + PROVIDER_RESPONSE_WINDOW_MS;
  const settled = await Promise.allSettled(eligible.map(async (provider) => {
    const started = Date.now();
    const tracks = await withinDeadline(
      provider.search(query, quality, atmos, authHeaders),
      deadline,
      `${provider.name} exceeded the response window`
    );
    return { provider, tracks, latencyMs: Date.now() - started };
  }));
  const tracks = [];
  const sources = {};
  const latencies = {};
  const successfulIds = new Set();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    const { provider, tracks: rows, latencyMs } = result.value;
    successfulIds.add(provider.id);
    sources[provider.id] = rows.length;
    latencies[provider.id] = latencyMs;
    tracks.push(...rows);
  }
  return { tracks, sources, latencies, successfulIds };
}

function saveTrackMetadata(id, metadata) {
  if (trackMetadata.size >= 5000 && !trackMetadata.has(id)) trackMetadata.delete(trackMetadata.keys().next().value);
  trackMetadata.set(id, metadata);
}

async function searchAllUncached(query, quality, atmos, authHeaders) {
  const normalizedQuery = String(query).trim().toLowerCase().replace(/\\s+/g, " ");
  const key = `${quality}:${atmos}:${normalizedQuery}`;
  const hit = cached(searchCache, key);
  if (hit) return hit;

  const result = await searchProviderSet(allProviders, query, quality, atmos, authHeaders);
  const latencyByTrackId = new Map(result.tracks.map((track) => [
    track.id, result.latencies[track._providerId] ?? Number.MAX_SAFE_INTEGER
  ]));
  const tracks = dedupeTracks(result.tracks, 60)
    .map((track, index) => ({ track, index, relevance: searchRelevanceScore(track, query) }))
    .sort((a, b) => b.relevance - a.relevance ||
      audioResolutionScore(b.track) - audioResolutionScore(a.track) ||
      (latencyByTrackId.get(a.track.id) ?? Number.MAX_SAFE_INTEGER) -
        (latencyByTrackId.get(b.track.id) ?? Number.MAX_SAFE_INTEGER) ||
      a.index - b.index)
    .map(({ track }) => track);

  for (const row of result.tracks) {
    saveTrackMetadata(row.id, {
      title: row.title, artist: row.artist, duration: row.duration || 0,
      sampleRate: row.sampleRate, bitDepth: row.bitDepth, bitrate: row.bitrate,
      format: row.format, audioQuality: row.audioQuality,
      _providerId: row._providerId, _upstreamId: row._upstreamId
    });
  }
  return save(searchCache, key, {
    tracks, sources: result.sources, searchMode: "all-providers"
  }, SEARCH_TTL);
}

async function searchAll(query, quality, atmos, authHeaders) {
  const key = `${quality}:${atmos}:${String(query).trim().toLowerCase().replace(/\s+/g, " ")}`;
  if (searchInflight.has(key)) return searchInflight.get(key);
  const pending = searchAllUncached(query, quality, atmos, authHeaders);
  searchInflight.set(key, pending);
  try { return await pending; }
  finally { if (searchInflight.get(key) === pending) searchInflight.delete(key); }
}

async function resolveMirrorTier(providers, metadata, query, quality, atmos, authHeaders) {
  const eligible = providers.filter((provider) => provider.enabled && provider.baseUrl && isProviderAvailable(provider));
  if (!eligible.length) return [];
  const searchDeadline = Date.now() + PROVIDER_RESPONSE_WINDOW_MS;
  const searches = await Promise.allSettled(eligible.map(async (provider) => {
    const started = Date.now();
    const rows = await withinDeadline(
      provider.search(query, quality, atmos, authHeaders),
      searchDeadline,
      `${provider.name} search exceeded the response window`
    );
    return { provider, rows, latencyMs: Date.now() - started };
  }));
  const candidates = [];
  for (const result of searches) {
    if (result.status !== "fulfilled") continue;
    for (const row of result.value.rows) {
      const matchScore = trackMatchScore(row, metadata);
      const delta = metadata.duration && row.duration ? Math.abs(metadata.duration - row.duration) : 0;
      const tolerance = metadata.duration ? Math.max(8, Math.min(18, metadata.duration * 0.04)) : 18;
      if (matchScore < 0.72 || delta > tolerance) continue;
      candidates.push({
        provider: result.value.provider, row, searchLatencyMs: result.value.latencyMs,
        matchScore: matchScore * 100 - delta * 0.5
      });
    }
  }
  candidates.sort((a, b) =>
    audioResolutionScore(b.row) - audioResolutionScore(a.row) ||
    a.searchLatencyMs - b.searchLatencyMs || b.matchScore - a.matchScore
  );

  const resolveDeadline = Date.now() + PROVIDER_RESPONSE_WINDOW_MS;
  const resolved = await Promise.allSettled(candidates.slice(0, 12).map(async (candidate) => {
    const started = Date.now();
    const stream = await withinDeadline(
      candidate.provider.resolve(candidate.row._upstreamId, quality, atmos, authHeaders),
      resolveDeadline,
      `${candidate.provider.name} stream exceeded the response window`
    );
    if (!stream) throw new Error("provider returned no playable stream");
    return {
      stream,
      score: audioResolutionScore(stream) || audioResolutionScore(candidate.row),
      matchScore: candidate.matchScore,
      latencyMs: candidate.searchLatencyMs + Date.now() - started
    };
  }));
  return resolved.filter((result) => result.status === "fulfilled").map((result) => result.value);
}

async function resolveTrackUncached(encodedId, quality, atmos, authHeaders) {
  const parsed = unpackTrackId(encodedId);
  if (!parsed) return null;
  const cacheKey = `${encodedId}:${quality}:${atmos}`;
  const hit = cached(streamCache, cacheKey);
  if (hit) return hit;

  const metadata = trackMetadata.get(encodedId);
  let candidates = [];
  if (metadata?.title) {
    const query = [metadata.artist, metadata.title].filter(Boolean).join(" ");
    candidates = await resolveMirrorTier(allProviders, metadata, query, quality, atmos, authHeaders);
  } else {
    const preferred = findProvider(parsed.providerId);
    if (preferred && isProviderAvailable(preferred)) {
      try {
        const deadline = Date.now() + PROVIDER_RESPONSE_WINDOW_MS;
        const stream = await withinDeadline(
          preferred.resolve(parsed.upstreamId, quality, atmos, authHeaders),
          deadline,
          "provider stream exceeded the response window"
        );
        if (stream) candidates = [{ stream, score: audioResolutionScore(stream), matchScore: 0, latencyMs: 0 }];
      } catch { /* provider unavailable; no playable result */ }
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || a.latencyMs - b.latencyMs || b.matchScore - a.matchScore);
  return save(streamCache, cacheKey, candidates[0].stream, STREAM_TTL);
}

async function resolveTrack(encodedId, quality, atmos, authHeaders) {
  const key = `${encodedId}:${quality}:${atmos}`;
  if (streamInflight.has(key)) return streamInflight.get(key);
  const pending = resolveTrackUncached(encodedId, quality, atmos, authHeaders);
  streamInflight.set(key, pending);
  try { return await pending; }
  finally { if (streamInflight.get(key) === pending) streamInflight.delete(key); }
}


const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "X-BitChord-Token, X-BitChord-Proof, Content-Type",
      "access-control-max-age": "86400"
    });
    return res.end();
  }
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" }, { allow: "GET, OPTIONS" });
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (path === "/" || path === "/manifest.json") return json(res, 200, manifest);

  const verified = await auth.verify(req.headers);
  if (!verified.ok) {
    const refusal = auth.refusal(verified);
    return json(res, refusal.status, await refusal.json(), Object.fromEntries(refusal.headers));
  }
  const upstreamAuth = {
    "X-BitChord-Token": req.headers["x-bitchord-token"],
    "X-BitChord-Proof": req.headers["x-bitchord-proof"]
  };
  if (path === "/health") {
    const providers = providerStatus();
    return json(res, 200, {
      ok: true,
      node: process.version,
      audioSources: providers.filter((provider) => provider.enabled && !provider.id.includes("deezer")).map((provider) => provider.name),
      providers
    });
  }
  if (path === "/search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) return json(res, 200, { tracks: [] });
    if (query.length > 200) return json(res, 400, { error: "query_too_long", tracks: [] });
    try {
      const quality = cleanQuality(url.searchParams.get("quality"));
      const atmos = cleanAtmos(url.searchParams.get("atmos"));
      const result = await searchAll(query, quality, atmos, upstreamAuth);
      return json(res, 200, { tracks: result.tracks }, { "X-Addon-Sources": encodeURIComponent(JSON.stringify(result.sources)) });
    } catch (error) {
      return json(res, 502, { error: "search_failed", message: String(error.message || error), tracks: [] });
    }
  }
  if (path.startsWith("/stream/")) {
    let id;
    try { id = decodeURIComponent(path.slice("/stream/".length)); }
    catch { return json(res, 400, { error: "invalid_track_id" }); }
    const quality = cleanQuality(url.searchParams.get("quality"));
    const atmos = cleanAtmos(url.searchParams.get("atmos"));
    const stream = await resolveTrack(id, quality, atmos, upstreamAuth);
    return stream ? json(res, 200, stream) : json(res, 404, { error: "stream_not_found" });
  }
  return json(res, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0", () => console.log(
  `MultiSource BitChord listening on :${port}; auth hosts: ${hostList.join(", ")}`
));
