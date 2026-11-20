import { normalizeTrack } from "../normalize.js";

const REQUEST_TIMEOUT_MS = 20_000;
const QUALITY_CHOICES = {
  lossless: ["hi_res_lossless", "HI_RES_LOSSLESS", "hi_res", "lossless", "LOSSLESS"],
  high: ["high", "HIGH"],
  low: ["low", "LOW"]
};

const definitions = [
  { id: "eljohn-mono", name: "Eljohnzc Monochrome", role: "primary", baseUrl: "https://eljohnzc-mono.de.deplexo.com" },
  { id: "qobuz-addon", name: "Qobuz Addon", role: "primary", baseUrl: "https://qobuz-addon.vercel.app" },
  { id: "confih", name: "Confih Hi-Res", role: "primary", baseUrl: "https://bitchord.confih.tech" },
  { id: "gglos", name: "gglos", role: "primary", baseUrl: "https://gglos.geisselgottes.cfd" },
  { id: "lastbabe", name: "LastBabe", role: "primary", baseUrl: "https://lastbabe-addon.de.deplexo.com" },
  { id: "tido", name: "Tido", role: "primary", baseUrl: "https://tido.tido.tido.dpdns.org" }
];

function cleanQuality(value) {
  const quality = String(value || "lossless").toLowerCase();
  return Object.hasOwn(QUALITY_CHOICES, quality) ? quality : "lossless";
}

function rowsFrom(payload) {
  if (Array.isArray(payload)) return payload;
  const rows = payload?.tracks ?? payload?.results ?? payload?.data?.tracks ?? payload?.data?.results ?? payload?.data;
  return Array.isArray(rows) ? rows : [];
}

function mapAddonTrack(row) {
  if (!row || typeof row !== "object") return row;
  let id = row.id ?? row.trackId;
  if (id == null) return row;
  try { id = decodeURIComponent(String(id)); } catch { id = String(id); }
  const artist = row.artistNames
    ? (Array.isArray(row.artistNames) ? row.artistNames.join(", ") : String(row.artistNames))
    : row.artist && typeof row.artist === "object"
      ? row.artist.name || ""
      : row.artist || (Array.isArray(row.artists)
        ? row.artists.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean).join(", ")
        : "");
  const album = row.album && typeof row.album === "object"
    ? row.album.title || ""
    : row.album || row.albumTitle || row.releaseTitle || "";
  const rawDuration = Number(row.durationMs ?? row.duration ?? row.durationSeconds ?? 0);
  const durationMs = row.durationMs != null ? rawDuration
    : rawDuration > 10000 ? rawDuration : undefined;
  const duration = durationMs == null ? rawDuration : undefined;
  const artworkURL = row.artworkURL || row.albumArtworkURL || row.artwork ||
    row.albumArtwork || row.cover || (row.album && typeof row.album === "object" ? row.album.cover : undefined);
  return {
    ...row,
    id: String(id),
    artist,
    album,
    ...(durationMs != null ? { durationMs } : duration > 0 ? { duration } : {}),
    ...(artworkURL ? { artworkURL } : {})
  };
}

function makeProvider(definition) {
  const baseUrl = definition.baseUrl.replace(/\/+$/, "");
  let manifestCache = null;
  let manifestExpiresAt = 0;
  let manifestRequest = null;

  async function requestJson(path, timeoutMs = REQUEST_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(baseUrl + path, {
        headers: { accept: "application/json", "user-agent": "MultiSource-BitChord/1.3" },
        signal: controller.signal,
        redirect: "follow"
      });
      if (!response.ok) throw new Error(definition.name + " HTTP " + response.status);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function addonManifest() {
    if (manifestCache && Date.now() < manifestExpiresAt) return manifestCache;
    if (!manifestRequest) {
      manifestRequest = requestJson("/manifest.json")
        .then((manifest) => {
          if (!manifest || typeof manifest !== "object" || !manifest.id) throw new Error("Invalid addon manifest");
          manifestCache = manifest;
          manifestExpiresAt = Date.now() + 10 * 60 * 1000;
          return manifest;
        })
        .finally(() => { manifestRequest = null; });
    }
    return manifestRequest;
  }

  async function addonParams(quality, atmos) {
    const requested = cleanQuality(quality);
    const params = {};
    try {
      const manifest = await addonManifest();
      for (const setting of manifest.settings || []) {
        if (["string", "number", "boolean"].includes(typeof setting.default)) params[setting.key] = setting.default;
      }
      const qualitySetting = (manifest.settings || []).find((setting) => setting.key === "quality");
      const options = qualitySetting?.options || [];
      params.quality = QUALITY_CHOICES[requested].find((candidate) =>
        options.some((option) => option.value === candidate)
      ) || requested;
    } catch {
      params.quality = requested;
    }
    params.atmos = atmos === "auto" ? "auto" : "stereo";
    return params;
  }

  return {
    ...definition,
    baseUrl,
    enabled: true,
    async search(query, quality, atmos = "stereo") {
      const params = await addonParams(quality, atmos);
      params.q = String(query || "").trim();
      if (!params.q) return [];
      const payload = await requestJson("/search?" + new URLSearchParams(params));
      return rowsFrom(payload).slice(0, 30)
        .map((row) => normalizeTrack(mapAddonTrack(row), definition.id, cleanQuality(quality), atmos))
        .filter(Boolean);
    },
    async resolve(upstreamId, quality, atmos = "stereo") {
      const params = await addonParams(quality, atmos);
      const payload = await requestJson("/stream/" + encodeURIComponent(upstreamId) + "?" + new URLSearchParams(params), 20_000);
      const stream = payload?.stream && typeof payload.stream === "object"
        ? payload.stream
        : payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
          ? payload.data
          : payload;
      const url = stream?.url || stream?.streamURL || stream?.streamUrl || stream?.downloadUrl;
      if (typeof url !== "string" || !/^https:\/\//i.test(url) ||
          [true, 1, "true", "1"].includes(stream?.encrypted)) return null;
      const sampleRate = Number(stream.sampleRate ?? stream.sample_rate);
      const bitDepth = Number(stream.bitDepth ?? stream.bit_depth);
      const bitrate = Number(stream.bitrate);
      const codec = String(stream.codec || stream.format || "unknown").toLowerCase();
      return {
        url,
        codec,
        container: stream.container || stream.format || codec,
        format: codec,
        manifest: stream.manifest || "none",
        encrypted: false,
        ...(Number.isFinite(sampleRate) && sampleRate > 0 ? { sampleRate } : {}),
        ...(Number.isFinite(bitDepth) && bitDepth > 0 ? { bitDepth } : {}),
        ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrate } : {}),
        ...(stream.audioQuality || stream.quality ? { quality: stream.audioQuality || stream.quality } : {}),
        ...(stream.atmos ? { atmos: stream.atmos } : {}),
        provider: definition.name
      };
    }
  };
}

export const wioAddonProviders = definitions.map(makeProvider);
