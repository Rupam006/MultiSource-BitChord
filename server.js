import { readFileSync } from "node:fs";
import http from "node:http";
import { createBitChordAuth } from "./src/auth.js";
import { allProviders, primaryProviders, fallbackProviders, findProvider, providerStatus } from "./src/providers/index.js";
import { audioResolutionScore, dedupeTracks, searchRelevanceScore, unpackTrackId } from "./src/normalize.js";

const port = Number(process.env.PORT || 10000);
const hostList = (process.env.BITCHORD_HOSTS || process.env.RENDER_EXTERNAL_HOSTNAME || "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const auth = createBitChordAuth({ hosts: hostList });
const manifest = JSON.parse(readFileSync(new URL("./manifest.json", import.meta.url), "utf8"));

const searchCache = new Map();
const streamCache = new Map();
const trackMetadata = new Map();
const SEARCH_TTL = 3 * 60 * 1000;
const STREAM_TTL = 45 * 1000;

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
  const eligible = providers.filter((provider) => provider.enabled && provider.baseUrl);
  const settled = await Promise.allSettled(
    eligible.map(async (provider) => ({
      provider,
      tracks: await provider.search(query, quality, atmos, authHeaders)
    }))
  );
  const tracks = [];
  const sources = {};
  const successfulIds = new Set();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    const { provider, tracks: rows } = result.value;
    successfulIds.add(provider.id);
    sources[provider.id] = rows.length;
    tracks.push(...rows);
  }
  return { tracks, sources, successfulIds };
}

function saveTrackMetadata(id, metadata) {
  if (trackMetadata.size >= 5000 && !trackMetadata.has(id)) trackMetadata.delete(trackMetadata.keys().next().value);
  trackMetadata.set(id, metadata);
}

async function searchAll(query, quality, atmos, authHeaders) {
  const normalizedQuery = String(query).trim().toLowerCase().replace(/\\s+/g, " ");
  const key = `${quality}:${atmos}:${normalizedQuery}`;
  const hit = cached(searchCache, key);
  if (hit) return hit;

  // Always search the primary tier first. If it returns only a small catalogue,
  // top it up with fallback results instead of hiding them until total failure.
  const primaryResult = await searchProviderSet(primaryProviders, query, quality, atmos, authHeaders);
  const primaryUnique = dedupeTracks(primaryResult.tracks, 60);
  const usefulPrimaryCount = primaryUnique.filter((track) => searchRelevanceScore(track, query) >= 120).length;
  let result = { ...primaryResult, searchMode: "primary" };
  if (usefulPrimaryCount < 12) {
    const fallbackResult = await searchProviderSet(fallbackProviders, query, quality, atmos, authHeaders);
    result = {
      tracks: [...primaryResult.tracks, ...fallbackResult.tracks],
      sources: { ...primaryResult.sources, ...fallbackResult.sources },
      successfulIds: new Set([...primaryResult.successfulIds, ...fallbackResult.successfulIds]),
      searchMode: primaryResult.tracks.length ? "primary+fallback" : "fallback"
    };
  }

  const tracks = dedupeTracks(result.tracks, 60)
    .map((track, index) => ({ track, index, relevance: searchRelevanceScore(track, query) }))
    .sort((a, b) => b.relevance - a.relevance ||
      audioResolutionScore(b.track) - audioResolutionScore(a.track) || a.index - b.index)
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
    tracks,
    sources: result.sources,
    searchMode: result.searchMode
  }, SEARCH_TTL);
}

async function resolveMirrorTier(providers, metadata, query, quality, atmos, authHeaders) {
  const eligible = providers.filter((provider) => provider.enabled && provider.baseUrl);
  if (!eligible.length) return [];

  const searches = await Promise.allSettled(eligible.map(async (provider) => ({
    provider,
    rows: await provider.search(query, quality, atmos, authHeaders)
  })));
  const candidates = [];
  for (const result of searches) {
    if (result.status !== "fulfilled") continue;
    for (const row of result.value.rows) {
      const titleScore = similarity(row.title, metadata.title);
      const artistScore = similarity(row.artist, metadata.artist);
      const delta = metadata.duration && row.duration
        ? Math.abs(metadata.duration - row.duration)
        : 0;
      if (titleScore < 0.92 || (metadata.artist && artistScore < 0.55) || delta > 12) continue;
      candidates.push({
        provider: result.value.provider,
        row,
        matchScore: titleScore * 60 + artistScore * 30 - delta
      });
    }
  }
  candidates.sort((a, b) =>
    audioResolutionScore(b.row) - audioResolutionScore(a.row) || b.matchScore - a.matchScore
  );

  const resolved = await Promise.allSettled(candidates.slice(0, 10).map(async (candidate) => {
    const stream = await candidate.provider.resolve(candidate.row._upstreamId, quality, atmos, authHeaders);
    if (!stream) throw new Error("mirror returned no playable stream");
    return {
      stream,
      score: audioResolutionScore(stream) || audioResolutionScore(candidate.row),
      matchScore: candidate.matchScore
    };
  }));
  return resolved.filter((result) => result.status === "fulfilled").map((result) => result.value);
}

async function resolveTrack(encodedId, quality, atmos, authHeaders) {
  const parsed = unpackTrackId(encodedId);
  if (!parsed) return null;
  const cacheKey = `${encodedId}:${quality}:${atmos}`;
  const hit = cached(streamCache, cacheKey);
  if (hit) return hit;

  const preferred = findProvider(parsed.providerId);
  const metadata = trackMetadata.get(encodedId);
  const preferredAttempt = preferred?.enabled && preferred.baseUrl
    ? preferred.resolve(parsed.upstreamId, quality, atmos, authHeaders)
        .then((stream) => stream ? {
          stream,
          score: audioResolutionScore(stream) || audioResolutionScore(metadata || {}),
          matchScore: Number.MAX_SAFE_INTEGER
        } : null)
        .catch(() => null)
    : Promise.resolve(null);

  // Resolve the selected source and primary mirrors concurrently. Do not pay
  // for fallback mirror searches when either route already produced a stream.
  let primaryStreams = [];
  if (metadata?.title) {
    const query = [metadata.artist, metadata.title].filter(Boolean).join(" ");
    const primaryPeers = allProviders.filter((provider) =>
      provider !== preferred && provider.role === "primary"
    );
    primaryStreams = await resolveMirrorTier(
      primaryPeers, metadata, query, quality, atmos, authHeaders
    );
  }

  const preferredResult = await preferredAttempt;
  let candidates = [...primaryStreams, ...(preferredResult ? [preferredResult] : [])];
  if (!candidates.length && metadata?.title) {
    const query = [metadata.artist, metadata.title].filter(Boolean).join(" ");
    const fallbackPeers = allProviders.filter((provider) =>
      provider !== preferred && provider.role !== "primary"
    );
    candidates = await resolveMirrorTier(
      fallbackPeers, metadata, query, quality, atmos, authHeaders
    );
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.score - a.score || b.matchScore - a.matchScore);
  return save(streamCache, cacheKey, candidates[0].stream, STREAM_TTL);
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
