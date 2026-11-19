import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTrack, dedupeTracks, unpackTrackId } from "../src/normalize.js";

test("normalizes provider track ids and metadata", () => {
  const row = normalizeTrack({ id: "track/42", title: "Signal", artist: [{ name: "Artist A" }, { name: "Artist B" }], durationMs: 183000 }, "demo");
  assert.equal(row.id, "demo:" + Buffer.from("track/42").toString("base64url"));
  assert.equal(row.artist, "Artist A, Artist B");
  assert.equal(row.duration, 183);
  assert.deepEqual(unpackTrackId(row.id), { providerId: "demo", upstreamId: "track/42" });
});

test("exposes exact resolution metadata and selected quality tier", () => {
  const row = normalizeTrack({
    id: "hires-1",
    title: "Resolution Test",
    format: "flac",
    sampleRate: 192000,
    bitDepth: 24,
    bitrate: 9216
  }, "demo", "high");
  assert.equal(row.resolution, "24-bit / 192 kHz");
  assert.equal(row.sampleRate, 192000);
  assert.equal(row.bitDepth, 24);
  assert.equal(row.bitrate, 9216);
  assert.equal(row.qualityTier, "High quality · Stereo");
  assert.equal(row.spatialAudioPreference, "Stereo");
});

test("includes selected Dolby Atmos preference without claiming detected Atmos playback", () => {
  const row = normalizeTrack({ id: "atmos-1", title: "Spatial Test", format: "flac" }, "demo", "lossless", "auto");
  assert.equal(row.qualityTier, "Lossless / Hi-Res · Dolby Atmos (when available)");
  assert.equal(row.spatialAudioPreference, "Dolby Atmos (when available)");
  assert.equal("spatialAudio" in row, false);
});

test("reports detected Dolby Atmos only when upstream metadata confirms it", () => {
  const row = normalizeTrack({ id: "atmos-2", title: "Confirmed Atmos", atmos: true }, "demo");
  assert.equal(row.spatialAudio, "Dolby Atmos");
});

test("deduplicates equivalent title, artist and duration", () => {
  const rows = [
    normalizeTrack({ id: "1", title: "Song!", artist: "The Artist", duration: 180 }, "a"),
    normalizeTrack({ id: "2", title: "song", artist: "the artist", duration: 180 }, "b")
  ];
  const result = dedupeTracks(rows);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, rows[0].id);
  assert.equal("_upstreamId" in result[0], false);
});
