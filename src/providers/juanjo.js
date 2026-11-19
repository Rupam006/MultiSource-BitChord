import { normalizeTrack } from "../normalize.js";

const UA = "MultiSource-BitChord/1.2";
const JSON_HEADERS = { accept: "application/json", "user-agent": UA };
const TIMEOUT_MS = 9000;

async function requestJson(url, timeoutMs = TIMEOUT_MS, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { headers: { ...JSON_HEADERS, ...headers }, signal: controller.signal, redirect: "follow" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function cleanQuality(value) {
  const q = String(value || "lossless").toLowerCase();
  return ["lossless", "high", "low"].includes(q) ? q : "lossless";
}
function upstreamQuality(value) {
  return ({ lossless: "HI_RES", high: "LOSSLESS", low: "LOW" })[cleanQuality(value)];
}
function numericId(value) {
  const id = String(value ?? "");
  return /^\d+$/.test(id) ? id : "";
}
function mapRows(rows, provider) {
  return rows.filter(Boolean).map((row) => ({ ...row, source: provider })).filter((row) => row.id && row.title);
}

// The Juanjo addon requires hardware-bound BitChord proofs on its own hostname.
// These adapters use its documented public upstreams directly instead of proxying
// its protected /search and /stream endpoints.
async function qobuzSearch(query) {
  const base = (process.env.JUANJO_QOBUZ_UPSTREAM_URL || "https://soundfean-musics.onrender.com/a").replace(/\/+$/, "");
  const data = await requestJson(`${base}/search?q=${encodeURIComponent(query)}&quality=LOSSLESS`);
  return mapRows((data?.tracks || []).map((item) => {
    const id = numericId(item?.id);
    if (!id || !item?.title) return null;
    return {
      id, title: item.title, artist: item.artist || "", album: item.album || "",
      duration: Number(item.duration) || undefined, artworkURL: item.artworkURL || undefined,
      format: "flac", audioQuality: /24[ -]?bit/i.test(String(item.audioQuality || "")) ? "HI_RES_LOSSLESS" : "LOSSLESS"
    };
  }), "Qobuz");
}
async function qobuzResolve(id, quality) {
  const base = (process.env.JUANJO_QOBUZ_UPSTREAM_URL || "https://soundfean-musics.onrender.com/a").replace(/\/+$/, "");
  const data = await requestJson(`${base}/stream/${encodeURIComponent(id)}?quality=${upstreamQuality(quality)}`, 12000);
  if (!data?.url || !/^https:\/\//i.test(data.url) || data.encrypted === true) return null;
  return {
    url: data.url, codec: data.codec || "unknown", container: data.container || data.codec || "unknown",
    manifest: data.manifest || "none", encrypted: false,
    ...(Number(data.sampleRate) > 0 ? { sampleRate: Number(data.sampleRate) } : {}),
    ...(Number(data.bitDepth) > 0 ? { bitDepth: Number(data.bitDepth) } : {}),
    ...(Number(data.bitrate) > 0 ? { bitrate: Number(data.bitrate) } : {}),
    ...(data.codec ? { format: String(data.codec).toLowerCase() } : {}),
    provider: "Qobuz"
  };
}

const MONO_REGISTRY = "https://raw.githubusercontent.com/monochrome-music/monochrome/main/public/instances.json";
const MONO_MODERN = "https://tracks.monochrome.st";
let monoInstances = { at: 0, urls: [] };
async function getMonoInstances() {
  if (Date.now() - monoInstances.at < 20 * 60 * 1000 && monoInstances.urls.length) return monoInstances.urls;
  try {
    const data = await requestJson(MONO_REGISTRY, 6000);
    const urls = [...new Set([...(data?.api || []), ...(data?.streaming || [])]
      .map((v) => String(v || "").trim().replace(/\/+$/, ""))
      .filter((v) => /^https?:\/\//i.test(v)))];
    if (urls.length) monoInstances = { at: Date.now(), urls };
  } catch {}
  return monoInstances.urls;
}
function monoRows(data) {
  for (const rows of [data?.items, data?.data?.items, data?.tracks, data?.data?.tracks, Array.isArray(data?.data) ? data.data : null, data?.topResults]) {
    if (Array.isArray(rows)) return rows;
  }
  return [];
}
function mapMono(item) {
  const id = numericId(item?.trackId ?? item?.id);
  if (!id || !item?.title) return null;
  const artist = Array.isArray(item.artistNames) ? item.artistNames.join(", ") : item?.artist?.name || (item?.artists || []).map((a) => a?.name).filter(Boolean).join(", ");
  const rawDuration = Number(item.duration) || 0;
  const duration = rawDuration > 3600 ? Math.round(rawDuration / 1000) : rawDuration;
  const hires = Array.isArray(item.mediaMetadata?.tags) && item.mediaMetadata.tags.includes("HIRES_LOSSLESS");
  return {
    id, title: item.title, artist, album: item.album?.title || item.releaseTitle || "",
    duration: duration || undefined, artworkURL: /^https?:\/\//i.test(String(item.artwork || "")) ? item.artwork : undefined,
    format: "flac", audioQuality: hires ? "HI_RES_LOSSLESS" : "LOSSLESS"
  };
}
async function monoSearch(query) {
  const headers = { "user-agent": "Mozilla/5.0", "x-client": "BiniLossless/v3.4", origin: "https://monochrome.st", referer: "https://monochrome.st/" };
  const candidates = [MONO_MODERN, ...(await getMonoInstances()).slice(0, 5)];
  const settled = await Promise.allSettled(candidates.map((base, i) =>
    requestJson(i === 0 ? `${base}/search?q=${encodeURIComponent(query)}` : `${base}/search/?s=${encodeURIComponent(query)}`, 6500, headers)
  ));
  const output = [];
  const seen = new Set();
  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const item of monoRows(result.value)) {
      const row = mapMono(item);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id); output.push(row);
      if (output.length >= 25) break;
    }
    if (output.length >= 25) break;
  }
  return mapRows(output, "Monochrome / Tidal");
}
async function probeFlac(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { headers: { range: "bytes=0-63", "user-agent": UA }, signal: controller.signal, redirect: "follow" });
    if (!response.ok && response.status !== 206) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (length < 64) {
      const part = await reader.read();
      if (part.done) break;
      chunks.push(part.value);
      length += part.value.length;
    }
    await reader.cancel().catch(() => {});
    const bytes = new Uint8Array(Math.min(length, 64));
    let offset = 0;
    for (const chunk of chunks) {
      const take = Math.min(chunk.length, bytes.length - offset);
      if (take <= 0) break;
      bytes.set(chunk.subarray(0, take), offset);
      offset += take;
    }
    if (bytes.length < 42 || String.fromCharCode(...bytes.slice(0, 4)) !== "fLaC") return null;
    const si = bytes.slice(8, 42);
    const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
    const bitDepth = (((si[12] & 1) << 4) | (si[13] >> 4)) + 1;
    const channels = ((si[12] >> 1) & 7) + 1;
    if (!sampleRate || !bitDepth) return null;
    return { url, codec: "flac", container: "flac", manifest: "none", encrypted: false, sampleRate, bitDepth, channels, format: "flac", provider: "Monochrome / Tidal" };
  } catch { return null; }
  finally { clearTimeout(timer); }
}
async function monoResolve(id, quality) {
  const q = cleanQuality(quality).toUpperCase();
  const direct = await probeFlac(`${MONO_MODERN}/track/${encodeURIComponent(id)}?quality=${q}`);
  if (direct) return direct;
  const instances = await getMonoInstances();
  const results = await Promise.allSettled(instances.slice(0, 6).map((base) =>
    requestJson(`${base}/track/?id=${encodeURIComponent(id)}&quality=${q}`, 8500, { "user-agent": "Mozilla/5.0", "x-client": "BiniLossless/v3.4" })
  ));
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const body = result.value?.data || result.value;
    if (!body?.manifest || body.assetPresentation === "PREVIEW" || (Number(body.duration) > 0 && Number(body.duration) <= 30)) continue;
    let decoded;
    try { decoded = JSON.parse(Buffer.from(body.manifest, "base64").toString("utf8")); } catch { continue; }
    const url = Array.isArray(decoded.urls) ? decoded.urls[0] : decoded.url;
    if (!url || !/^https?:\/\//i.test(url)) continue;
    const verified = await probeFlac(url);
    if (verified) return verified;
  }
  return null;
}

const METING = (process.env.JUANJO_NETEASE_METING_URL || "https://api.qijieya.cn/meting/").replace(/\/+$/, "") + "/";
async function neteaseSearch(query) {
  const rows = await requestJson(`${METING}?server=netease&type=search&id=${encodeURIComponent(query)}&limit=20`, 10000, { "user-agent": "Mozilla/5.0" });
  if (!Array.isArray(rows)) return [];
  return mapRows(rows.map((item) => {
    const match = /[?&]id=(\d+)/.exec(String(item?.url || ""));
    if (!match || !item?.name) return null;
    return { id: match[1], title: item.name, artist: Array.isArray(item.artist) ? item.artist.join(", ") : String(item.artist || ""), album: String(item.album || ""), artworkURL: item.pic || undefined, format: "flac", audioQuality: "LOSSLESS" };
  }), "Netease");
}
async function neteaseResolve(id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(`${METING}?server=netease&type=url&id=${encodeURIComponent(id)}&br=999000`, { headers: { "user-agent": "Mozilla/5.0" }, signal: controller.signal, redirect: "manual" });
    const url = response.headers.get("location");
    if (!url || !/^https:\/\//i.test(url)) return null;
    const verified = await probeFlac(url);
    return verified ? { ...verified, provider: "Netease" } : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function deezerSearch(query) {
  const data = await requestJson(`https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=25`);
  return mapRows((data?.data || []).map((item) => item?.id && item?.title ? ({
    id: String(item.id), title: item.title, artist: item.artist?.name || "", album: item.album?.title || "",
    duration: Number(item.duration) || undefined, artworkURL: item.album?.cover_xl || item.album?.cover_medium || undefined,
    format: "unknown", audioQuality: "UNKNOWN"
  }) : null), "Deezer catalogue");
}

function provider(id, name, searchFn, resolveFn) {
  return {
    id, name, role: "primary", enabled: true, baseUrl: "direct-upstream",
    async search(query, quality, atmos) {
      const rows = await searchFn(String(query || "").trim());
      return rows.map((row) => normalizeTrack(row, id, quality, atmos)).filter(Boolean);
    },
    async resolve(upstreamId, quality) { return resolveFn ? resolveFn(String(upstreamId), quality) : null; }
  };
}

export const juanjoProviders = [
  provider("juanjo-mono", "Monochrome / Tidal", monoSearch, monoResolve),
  provider("juanjo-qobuz", "Qobuz (Juanjo upstream)", qobuzSearch, qobuzResolve),
  provider("juanjo-netease", "Netease (Meting)", neteaseSearch, neteaseResolve),
  provider("juanjo-deezer", "Deezer catalogue (mirror playback)", deezerSearch, null)
];
