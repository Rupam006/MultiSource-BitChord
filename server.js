import { readFileSync } from "node:fs";
import http from "node:http";
import { createBitChordAuth } from "./src/auth.js";
import { allProviders, findProvider, providerStatus } from "./src/providers/index.js";
import { audioResolutionScore, dedupeTracks, unpackTrackId } from "./src/normalize.js";

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

async function searchAll(query, quality, atmos, authHeaders) {
  const key = `${quality}:${atmos}:${query.toLowerCase()}`;
  const hit = cached(searchCache, key);
  if (hit) return hit;

  const primaryProviders = allProviders.filter((provider) => provider.role === "primary");
  const fallbackProviders = allProviders.filter((provider) => provider.role !== "primary");
  const primary = await searchProviderSet(primaryProviders, query, quality, atmos, authHeaders);

  // prodpwh and the Juanjo family are the two primary groups. Search both at once.
  // Enter fallback mode if neither primary returns a match, or either primary group
  // is unreachable. A partially working primary result is retained and compared
  // with all fallback results when fallback mode is entered.
  const prodpwhConnected = primary.successfulIds.has("prodpwh");
  const juanjoConnected = [...primary.successfulIds].some((id) => id.startsWith("juanjo-"));
  const shouldSearchFallback = primary.tracks.length === 0 || !prodpwhConnected || !juanjoConnected;

  let tracks = [...primary.tracks];
  const sources = { ...primary.sources };
  if (shouldSearchFallback) {
    const fallback = await searchProviderSet(fallbackProviders, query, quality, atmos, authHeaders);
    tracks.push(...fallback.tracks);
    Object.assign(sources, fallback.sources);
  }

  for (const row of tracks) {
    trackMetadata.set(row.id, {
      title: row.title, artist: row.artist, duration: row.duration || 0,
      sampleRate: row.sampleRate, bitDepth: row.bitDepth, bitrate: row.bitrate,
      format: row.format, audioQuality: row.audioQuality,
      _providerId: row._providerId, _upstreamId: row._upstreamId
    });
  }
  const combined = dedupeTracks(tracks);
  return save(searchCache, key, {
    tracks: combined,
    sources,
    searchMode: shouldSearchFallback ? "primary+fallback" : "primary"
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
      score: Math.max(audioResolutionScore(stream), audioResolutionScore(candidate.row)),
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
          score: Math.max(audioResolutionScore(stream), audioResolutionScore(metadata || {})),
          matchScore: Number.MAX_SAFE_INTEGER
        } : null)
        .catch(() => null)
    : Promise.resolve(null);

  // Compare every reachable primary stream before falling back. If the selected
  // primary cannot resolve, its primary peers are searched together; only when no
  // primary stream is playable do we fan out to all fallback backends.
  let primaryPeers = [];
  let fallbackStreams = [];
  if (metadata?.title) {
    const query = [metadata.artist, metadata.title].filter(Boolean).join(" ");
    if (preferred?.role === "primary") {
      primaryPeers = await resolveMirrorTier(
        allProviders.filter((provider) => provider.role === "primary" && provider !== preferred),
        metadata, query, quality, atmos, authHeaders
      );
    } else {
      fallbackStreams = await resolveMirrorTier(
        allProviders.filter((provider) => provider.role !== "primary" && provider !== preferred),
        metadata, query, quality, atmos, authHeaders
      );
    }
  }

  const preferredResult = await preferredAttempt;
  let candidates = [...primaryPeers, ...(preferredResult ? [preferredResult] : [])];
  if (candidates.length) {
    candidates.sort((a, b) => b.score - a.score || b.matchScore - a.matchScore);
    return save(streamCache, cacheKey, candidates[0].stream, STREAM_TTL);
  }

  if (preferred?.role === "primary" && metadata?.title) {
    const query = [metadata.artist, metadata.title].filter(Boolean).join(" ");
    fallbackStreams = await resolveMirrorTier(
      allProviders.filter((provider) => provider.role !== "primary"),
      metadata, query, quality, atmos, authHeaders
    );
  }
  candidates = [...fallbackStreams, ...(preferredResult ? [preferredResult] : [])];
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
  const upstreamAuth = {
    "X-BitChord-Token": req.headers["x-bitchord-token"],
    "X-BitChord-Proof": req.headers["x-bitchord-proof"]
  };
  if (path === "/health") return json(res, 200, { ok: true, providers: providerStatus() });
  if (path === "/search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) return json(res, 200, { tracks: [] });
    try {
      const quality = cleanQuality(url.searchParams.get("quality"));
      const atmos = cleanAtmos(url.searchParams.get("atmos"));
      const result = await searchAll(query, quality, atmos, upstreamAuth);
      return json(res, 200, { tracks: result.tracks });
    } catch (error) {
      return json(res, 502, { error: "search_failed", message: String(error.message || error), tracks: [] });
    }
  }
  if (path.startsWith("/stream/")) {
    const id = decodeURIComponent(path.slice("/stream/".length));
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
