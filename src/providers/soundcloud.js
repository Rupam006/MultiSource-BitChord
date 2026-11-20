import { normalizeTrack } from "../normalize.js";

const API_BASE = "https://api-v2.soundcloud.com";
const HOME_URL = "https://soundcloud.com/";
const USER_AGENT = "Mozilla/5.0 (compatible; MultiSource-BitChord/1.0)";
const REQUEST_TIMEOUT_MS = 10000;
const CLIENT_ID_TTL_MS = 12 * 60 * 60 * 1000;
const TRACK_CACHE_TTL_MS = 2 * 60 * 1000;

let cachedClientId = "";
let clientIdExpiresAt = 0;
let clientIdRequest = null;
const trackCache = new Map();

async function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        ...(options.headers || {})
      },
      signal: controller.signal,
      redirect: "follow"
    });
  } finally {
    clearTimeout(timer);
  }
}

async function extractClientId() {
  const home = await fetchWithTimeout(HOME_URL, { headers: { accept: "text/html" } });
  if (!home.ok) throw new Error(`SoundCloud homepage HTTP ${home.status}`);
  const html = await home.text();

  const direct = html.match(/["']?client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/);
  if (direct) return direct[1];

  const bundles = [...html.matchAll(/src=["'](https:\/\/a-v2\.sndcdn\.com\/assets\/[^"']+\.js)["']/g)]
    .map((match) => match[1]);
  const fallbackBundles = bundles.length ? bundles : [...html.matchAll(/src=["'](https:\/\/[^"']*sndcdn\.com[^"']*\.js)["']/g)]
    .map((match) => match[1]);

  for (const bundleUrl of fallbackBundles.slice(-8).reverse()) {
    try {
      const response = await fetchWithTimeout(bundleUrl, { headers: { accept: "*/*" } }, 12000);
      if (!response.ok) continue;
      const body = await response.text();
      const match = body.match(/["']?client_id["']?\s*[:=]\s*["']([a-zA-Z0-9]{32})["']/)
        || body.match(/\("client_id=([a-zA-Z0-9]{32})"\)/)
        || body.match(/client_id=([a-zA-Z0-9]{32})/);
      if (match) return match[1];
    } catch {
      // Continue to another public SoundCloud bundle.
    }
  }
  throw new Error("Could not obtain a public SoundCloud client ID");
}

async function getClientId(forceRefresh = false) {
  if (!forceRefresh && cachedClientId && Date.now() < clientIdExpiresAt) return cachedClientId;
  if (!clientIdRequest) {
    clientIdRequest = extractClientId()
      .then((value) => {
        cachedClientId = value;
        clientIdExpiresAt = Date.now() + CLIENT_ID_TTL_MS;
        return value;
      })
      .finally(() => { clientIdRequest = null; });
  }
  return clientIdRequest;
}

async function soundCloudJson(path, extraParams = {}, retry = true) {
  const clientId = await getClientId();
  const url = new URL(`${API_BASE}/${String(path).replace(/^\/+/, "")}`);
  url.searchParams.set("client_id", clientId);
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }

  const response = await fetchWithTimeout(url, { headers: { accept: "application/json" } });
  if ((response.status === 401 || response.status === 403) && retry) {
    await getClientId(true);
    return soundCloudJson(path, extraParams, false);
  }
  if (!response.ok) throw new Error(`SoundCloud API HTTP ${response.status}`);
  return response.json();
}

function isFullPlayableTrack(track) {
  if (!track || track.streamable === false) return false;
  if (track.access && track.access !== "playable") return false;
  if (/^(?:SNIP|BLOCK)$/i.test(String(track.policy || ""))) return false;
  return true;
}

function transcodingFormat(transcoding) {
  const mime = String(transcoding?.format?.mime_type || "").toLowerCase();
  const preset = String(transcoding?.preset || "").toLowerCase();
  if (/aac|mp4|mp4a/.test(mime) || /^aac_/.test(preset)) return "m4a";
  if (/opus/.test(mime) || /^opus_/.test(preset)) return "opus";
  if (/mpeg|mp3/.test(mime)) return "mp3";
  return "";
}

function supportedTranscodings(track) {
  const transcodings = track?.media?.transcodings || [];
  return transcodings.filter((item) =>
    item?.url &&
    item?.format &&
    ["progressive", "hls"].includes(item.format.protocol) &&
    !item.snipped &&
    !/preview/i.test(String(item.preset || "")) &&
    Boolean(transcodingFormat(item))
  ).sort((a, b) => {
    const protocolScore = (item) => item.format.protocol === "progressive" ? 20 : 0;
    const formatScore = (item) => ({ m4a: 60, opus: 40, mp3: 20 })[transcodingFormat(item)] || 0;
    const bitrateScore = (item) => Number((String(item.preset || "").match(/_(\d+)k/i) || [])[1] || 0);
    return (protocolScore(b) + formatScore(b) + bitrateScore(b) / 100) -
      (protocolScore(a) + formatScore(a) + bitrateScore(a) / 100);
  });
}

function mapTrack(track) {
  if (!isFullPlayableTrack(track) || !supportedTranscodings(track).length || !track.id || !track.title) return null;
  const publisher = track.publisher_metadata || {};
  const user = track.user || {};
  const artwork = String(track.artwork_url || user.avatar_url || "").replace("-large.", "-t500x500.");
  const durationMs = Number(track.full_duration || track.duration) || 0;
  const transcoding = supportedTranscodings(track)[0];
  const format = transcodingFormat(transcoding);
  const bitrate = Number((String(transcoding.preset || "").match(/_(\d+)k/i) || [])[1] || 0) * 1000;
  return {
    id: String(track.id),
    title: track.title,
    artist: publisher.artist || track.metadata_artist || user.username || "",
    album: publisher.album_title || publisher.release_title || "",
    duration: durationMs > 0 ? durationMs / 1000 : undefined,
    artworkURL: artwork || undefined,
    format,
    audioQuality: transcoding.quality === "hq" ? "HIGH" : "UNKNOWN",
    ...(bitrate > 0 ? { bitrate } : {}),
    source: "SoundCloud"
  };
}

async function resolveTranscoding(transcoding, track, retry = true) {
  const clientId = await getClientId();
  const endpoint = new URL(transcoding.url);
  endpoint.searchParams.set("client_id", clientId);
  if (track.track_authorization) endpoint.searchParams.set("track_authorization", track.track_authorization);

  const response = await fetchWithTimeout(endpoint, { headers: { accept: "application/json" } });
  if ((response.status === 401 || response.status === 403) && retry) {
    await getClientId(true);
    const refreshedTrack = await soundCloudJson(`tracks/${encodeURIComponent(track.id)}`);
    if (!isFullPlayableTrack(refreshedTrack)) throw new Error("SoundCloud track is no longer playable");
    const refreshed = supportedTranscodings(refreshedTrack);
    if (!refreshed.length) throw new Error("SoundCloud has no full-length stream for this track");
    return resolveTranscoding(refreshed[0], refreshedTrack, false);
  }
  if (!response.ok) throw new Error(`SoundCloud stream resolver HTTP ${response.status}`);
  const payload = await response.json();
  const streamUrl = payload?.url;
  if (!streamUrl || !/^https:\/\//i.test(streamUrl)) throw new Error("SoundCloud returned no secure stream URL");

  const format = transcodingFormat(transcoding);
  const bitrate = Number((String(transcoding.preset || "").match(/_(\d+)k/i) || [])[1] || 0) * 1000;
  const isHls = transcoding.format.protocol === "hls";
  return {
    url: streamUrl,
    codec: format,
    container: isHls ? "mpegts" : format,
    format,
    manifest: isHls ? "hls" : "none",
    encrypted: false,
    ...(bitrate > 0 ? { bitrate } : {}),
    qualityTier: transcoding.quality === "hq" ? "SoundCloud high-quality stream" : "SoundCloud standard stream",
    spatialAudioPreference: "Stereo",
    provider: "SoundCloud"
  };
}

async function resolveTrack(id) {
  const key = String(id || "");
  if (!/^\d+$/.test(key)) return null;
  const cached = trackCache.get(key);
  let track = cached && cached.expiresAt > Date.now() ? cached.value : null;
  if (!track) {
    track = await soundCloudJson(`tracks/${encodeURIComponent(key)}`);
    trackCache.set(key, { value: track, expiresAt: Date.now() + TRACK_CACHE_TTL_MS });
    if (trackCache.size > 300) trackCache.delete(trackCache.keys().next().value);
  }
  if (!isFullPlayableTrack(track)) return null;
  const candidates = supportedTranscodings(track);
  if (!candidates.length) return null;

  let lastError;
  for (const candidate of candidates.slice(0, 5)) {
    try {
      return await resolveTranscoding(candidate, track);
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return null;
}

export const soundcloudProvider = {
  id: "soundcloud",
  name: "SoundCloud",
  role: "fallback",
  enabled: true,
  baseUrl: "https://api-v2.soundcloud.com",
  async search(query, quality, atmos) {
    const text = String(query || "").trim();
    if (!text) return [];
    const data = await soundCloudJson("search/tracks", { q: text, limit: 30, offset: 0, access: "playable" });
    const rows = Array.isArray(data?.collection) ? data.collection : [];
    return rows.map(mapTrack).filter(Boolean)
      .map((row) => normalizeTrack(row, "soundcloud", quality, atmos))
      .filter(Boolean);
  },
  async resolve(upstreamId) {
    const stream = await resolveTrack(upstreamId);
    return stream ? { ...stream, provider: "SoundCloud" } : null;
  }
};
