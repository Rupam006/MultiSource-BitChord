import { normalizeTrack } from "../normalize.js";

const BASE_URL = "https://tracks.monochrome.st";
const USER_AGENT = "MultiSource-BitChord/1.0";
const TIMEOUT_MS = 9000;

async function requestJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: controller.signal,
      redirect: "follow"
    });
    if (!response.ok) throw new Error(`Monochrome API HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function mapTrack(item) {
  const id = String(item?.trackId ?? item?.id ?? "");
  if (!/^\d+$/.test(id) || !item?.title) return null;
  const artist = Array.isArray(item.artistNames)
    ? item.artistNames.join(", ")
    : Array.isArray(item.artists)
      ? item.artists.map((entry) => entry?.name || entry?.displayName).filter(Boolean).join(", ")
      : item.artist?.name || "";
  const rawDuration = Number(item.duration) || 0;
  return {
    id,
    title: item.title,
    artist,
    album: item.albumTitle || item.releaseTitle || item.album?.title || "",
    duration: rawDuration > 1000 ? Math.round(rawDuration / 1000) : rawDuration || undefined,
    artworkURL: item.artwork || item.cover || item.album?.cover || undefined,
    format: "flac",
    audioQuality: "LOSSLESS"
  };
}

async function search(query) {
  const data = await requestJson(`${BASE_URL}/search?q=${encodeURIComponent(query)}`);
  const rows = Array.isArray(data?.tracks) ? data.tracks : [];
  return rows.map(mapTrack).filter(Boolean).slice(0, 30);
}

async function probeFlac(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { range: "bytes=0-63", "user-agent": USER_AGENT },
      signal: controller.signal,
      redirect: "follow"
    });
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
      const count = Math.min(chunk.length, bytes.length - offset);
      if (count <= 0) break;
      bytes.set(chunk.subarray(0, count), offset);
      offset += count;
    }
    if (bytes.length < 42 || String.fromCharCode(...bytes.slice(0, 4)) !== "fLaC") return null;
    const streamInfo = bytes.slice(8, 42);
    const sampleRate = (streamInfo[10] << 12) | (streamInfo[11] << 4) | (streamInfo[12] >> 4);
    const bitDepth = (((streamInfo[12] & 1) << 4) | (streamInfo[13] >> 4)) + 1;
    const channels = ((streamInfo[12] >> 1) & 7) + 1;
    if (!sampleRate || !bitDepth) return null;
    return { url, codec: "flac", container: "flac", format: "flac", manifest: "none", encrypted: false, sampleRate, bitDepth, channels };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolve(id) {
  if (!/^\d+$/.test(String(id))) return null;
  return probeFlac(`${BASE_URL}/track/${encodeURIComponent(id)}`);
}

export const monochromeProvider = {
  id: "monochrome",
  name: "Official Monochrome",
  role: "primary",
  enabled: true,
  baseUrl: BASE_URL,
  async search(query, quality, atmos) {
    const rows = await search(String(query || "").trim());
    return rows.map((row) => normalizeTrack(row, "monochrome", quality, atmos)).filter(Boolean);
  },
  async resolve(upstreamId) {
    const stream = await resolve(String(upstreamId));
    return stream ? { ...stream, provider: "Official Monochrome" } : null;
  }
};
