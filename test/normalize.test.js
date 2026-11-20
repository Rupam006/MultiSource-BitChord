import test from "node:test";
import assert from "node:assert/strict";
import { audioResolutionScore, normalizeTrack, dedupeTracks, unpackTrackId } from "../src/normalize.js";

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


test("deduplication keeps the highest reported audio resolution", () => {
  const standard = normalizeTrack({
    id: "standard", title: "Same Song", artist: "Same Artist", duration: 180,
    format: "flac", sampleRate: 44100, bitDepth: 16, audioQuality: "LOSSLESS"
  }, "prodpwh");
  const hires = normalizeTrack({
    id: "hires", title: "Same Song", artist: "Same Artist", duration: 180,
    format: "flac", sampleRate: 192000, bitDepth: 24, audioQuality: "HI_RES_LOSSLESS"
  }, "juanjo-mono");
  assert.ok(audioResolutionScore(hires) > audioResolutionScore(standard));
  const result = dedupeTracks([standard, hires]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, hires.id);
});


test("normalizes diacritics and ranks exact query matches above loose matches", async () => {
  const { normalizeSearchText, searchRelevanceScore } = await import("../src/normalize.js");
  assert.equal(normalizeSearchText("Beyoncé feat. Jay-Z"), "beyonce jay z");
  const exact = normalizeTrack({ id: "1", title: "Yellow", artist: "Coldplay" }, "a");
  const loose = normalizeTrack({ id: "2", title: "Yellow Submarine", artist: "Various" }, "b");
  assert.ok(searchRelevanceScore(exact, "Yellow") > searchRelevanceScore(loose, "Yellow"));
});

test("deduplicates provider variants with small duration differences", () => {
  const rows = [
    normalizeTrack({ id: "1", title: "Song (Remastered)", artist: "The Artist", duration: 181 }, "a"),
    normalizeTrack({ id: "2", title: "Song", artist: "The Artist", duration: 180 }, "b")
  ];
  assert.equal(dedupeTracks(rows).length, 1);
});


test("keeps second-based durations and converts explicit millisecond durations", () => {
  const seconds = normalizeTrack({ id: "seconds", title: "Seconds", duration: 5400 }, "demo");
  const milliseconds = normalizeTrack({ id: "milliseconds", title: "Milliseconds", durationMs: 183000 }, "demo");
  assert.equal(seconds.duration, 5400);
  assert.equal(milliseconds.duration, 183);
});
