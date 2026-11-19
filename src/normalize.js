const QUALITY_LABELS = {
  lossless: "Lossless / Hi-Res",
  high: "High quality",
  low: "Data saver"
};

export function normalizeTrack(track, providerId, requestedQuality = "lossless") {
  if (!track || typeof track !== "object" || !track.title) return null;
  const rawId = String(track.id ?? track.trackId ?? "");
  if (!rawId) return null;
  const id = Buffer.from(rawId).toString("base64url");
  const artistValue = track.artist ?? track.artists ?? "";
  const artist = Array.isArray(artistValue)
    ? artistValue.map((item) => typeof item === "string" ? item : item?.name).filter(Boolean).join(", ")
    : String(artistValue);
  const duration = Number(track.duration ?? track.durationSeconds ?? (Number(track.durationMs) ? Number(track.durationMs) / 1000 : 0));
  const sampleRate = Number(track.sampleRate ?? track.sample_rate);
  const bitDepth = Number(track.bitDepth ?? track.bit_depth);
  const bitrate = Number(track.bitrate);
  const format = String(track.format || track.codec || "unknown").toLowerCase();
  const quality = String(track.audioQuality || track.quality || (format === "flac" ? "LOSSLESS" : "UNKNOWN")).toUpperCase();
  const qualityTier = String(track.qualityTier || track.requestedQuality || requestedQuality || "lossless").toLowerCase();
  const resolution = Number.isFinite(bitDepth) && bitDepth > 0 && Number.isFinite(sampleRate) && sampleRate > 0
    ? `${bitDepth}-bit / ${(sampleRate / 1000).toFixed(sampleRate % 1000 === 0 ? 0 : 1)} kHz`
    : undefined;
  return {
    id: `${providerId}:${id}`,
    title: String(track.title),
    artist,
    album: String(track.album ?? ""),
    ...(Number.isFinite(duration) && duration > 0 ? { duration: duration > 3600 ? Math.round(duration / 1000) : duration } : {}),
    ...(track.artworkURL || track.artwork || track.cover ? { artworkURL: track.artworkURL || track.artwork || track.cover } : {}),
    format,
    audioQuality: quality,
    qualityTier: QUALITY_LABELS[qualityTier] || QUALITY_LABELS.lossless,
    ...(resolution ? { resolution } : {}),
    ...(Number.isFinite(sampleRate) && sampleRate > 0 ? { sampleRate } : {}),
    ...(Number.isFinite(bitDepth) && bitDepth > 0 ? { bitDepth } : {}),
    ...(Number.isFinite(bitrate) && bitrate > 0 ? { bitrate } : {}),
    ...(track.atmos ? { atmos: track.atmos } : {}),
    source: track.source || providerId,
    _providerId: providerId,
    _upstreamId: rawId
  };
}

export function dedupeTracks(tracks, limit = 60) {
  const seen = new Set();
  const output = [];
  for (const track of tracks) {
    const key = [track.title, track.artist, track.duration || ""].join("|")
      .toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9| ]/g, "").replace(/\s+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    const { _providerId, _upstreamId, ...publicTrack } = track;
    output.push(publicTrack);
    if (output.length >= limit) break;
  }
  return output;
}

export function unpackTrackId(value) {
  const [providerId, encoded] = String(value).split(":");
  if (!providerId || !encoded) return null;
  try { return { providerId, upstreamId: Buffer.from(encoded, "base64url").toString("utf8") }; }
  catch { return null; }
}
