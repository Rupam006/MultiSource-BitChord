export function normalizeTrack(track, providerId) {
  if (!track || typeof track !== "object" || !track.title) return null;
  const rawId = String(track.id ?? track.trackId ?? "");
  if (!rawId) return null;
  const id = Buffer.from(rawId).toString("base64url");
  const duration = Number(track.duration ?? track.durationSeconds ?? 0);
  return {
    id: `${providerId}:${id}`,
    title: String(track.title),
    artist: String(track.artist ?? track.artists ?? ""),
    album: String(track.album ?? ""),
    ...(Number.isFinite(duration) && duration > 0 ? { duration: duration > 3600 ? Math.round(duration / 1000) : duration } : {}),
    ...(track.artworkURL || track.artwork || track.cover ? { artworkURL: track.artworkURL || track.artwork || track.cover } : {}),
    format: String(track.format || track.codec || "flac").toLowerCase(),
    audioQuality: track.audioQuality || track.quality || "LOSSLESS",
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
