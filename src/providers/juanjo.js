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
  provider("juanjo-qobuz", "Qobuz (Juanjo upstream)", qobuzSearch, qobuzResolve),
  provider("juanjo-netease", "Netease (Meting)", neteaseSearch, neteaseResolve),
  provider("juanjo-deezer", "Deezer catalogue (mirror playback)", deezerSearch, null)
];
