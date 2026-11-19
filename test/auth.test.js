import test from "node:test";
import assert from "node:assert/strict";
import { createBitChordAuth } from "../src/auth.js";

test("rejects missing BitChord credentials with the expected challenge", async () => {
  const auth = createBitChordAuth({ hosts: ["example.onrender.com"] });
  const result = await auth.verify({});
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.equal(result.code, "missing");
  const response = auth.refusal(result);
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate"), /BitChord/);
});
