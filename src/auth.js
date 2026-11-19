const ISSUER = "https://bitchord-auth.kushagrasingh.in";
const AUDIENCE = "bitchord-addons";
const PROOF_CONTEXT = "bitchord-addon-proof/v1";
const enc = new TextEncoder();
const subtle = globalThis.crypto?.subtle;

function decode64url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
function encode64url(value) {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decode64url(value)));
}
function reject(status, code, message) {
  return { ok: false, status, code, message };
}
function normalizeHost(value) {
  return String(value).trim().toLowerCase().replace(/\.$/, "");
}

export function createBitChordAuth({ hosts, fetchImpl = fetch, now = Date.now } = {}) {
  if (!subtle) throw new Error("BitChord auth requires Node.js WebCrypto");
  const allowedHosts = [...new Set((hosts || []).map(normalizeHost).filter(Boolean))];
  if (!allowedHosts.length) throw new Error("Set BITCHORD_HOSTS or RENDER_EXTERNAL_HOSTNAME before starting");
  let keys = new Map();
  let keysLoadedAt = 0;
  let keyLoad = null;
  const deviceKeyCache = new Map();

  async function refreshKeys() {
    const response = await fetchImpl(`${ISSUER}/.well-known/jwks.json`, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`BitChord JWKS returned HTTP ${response.status}`);
    const payload = await response.json();
    const next = new Map();
    for (const jwk of payload.keys || []) {
      if (jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.kid && jwk.x) {
        next.set(jwk.kid, await subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, { name: "Ed25519" }, false, ["verify"]));
      }
    }
    if (!next.size) throw new Error("BitChord JWKS contained no Ed25519 signing keys");
    keys = next;
    keysLoadedAt = now();
  }

  async function signingKey(kid) {
    if (now() - keysLoadedAt > 60 * 60 * 1000 || !keys.has(kid)) {
      keyLoad ||= refreshKeys().finally(() => { keyLoad = null; });
      try { await keyLoad; } catch (error) { if (!keys.size) throw error; }
    }
    return keys.get(kid);
  }

  async function verify(headers) {
    const getHeader = (name) => typeof headers?.get === "function" ? headers.get(name) : headers?.[name] ?? headers?.[name.toLowerCase()];
    const token = getHeader("x-bitchord-token");
    const proof = getHeader("x-bitchord-proof");
    if (!token || !proof) return reject(401, "missing", "This addon only accepts requests from the official BitChord app");

    try {
      const parts = token.split(".");
      if (parts.length !== 3) return reject(401, "invalid_token", "Malformed token");
      const header = decodeJson(parts[0]);
      const claims = decodeJson(parts[1]);
      if (header.alg !== "EdDSA" || typeof header.kid !== "string") return reject(401, "invalid_token", "Unsupported token");
      let key;
      try { key = await signingKey(header.kid); }
      catch { return reject(503, "unavailable", "Could not load BitChord public signing keys"); }
      if (!key) return reject(401, "invalid_token", "Unknown signing key");
      const signatureValid = await subtle.verify({ name: "Ed25519" }, key, decode64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
      if (!signatureValid) return reject(401, "invalid_token", "Invalid token signature");

      const seconds = Math.floor(now() / 1000);
      const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== ISSUER || !audience.includes(AUDIENCE)) return reject(401, "invalid_token", "Token is not intended for BitChord addons");
      if (typeof claims.exp !== "number" || claims.exp + 60 < seconds) return reject(401, "expired", "BitChord token has expired");
      if (typeof claims.iat !== "number" || claims.iat - 60 > seconds) return reject(401, "invalid_token", "Token issue time is invalid");

      const jwk = claims.cnf?.jwk;
      if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) return reject(401, "invalid_token", "Token is not bound to a device key");
      const match = /^v1\.(\d{10,16})\.([A-Za-z0-9_-]{86})$/.exec(proof);
      if (!match) return reject(401, "invalid_proof", "Malformed BitChord proof");
      if (Math.abs(now() - Number(match[1])) > 120000) return reject(401, "stale_proof", "BitChord proof is outside the accepted time window");

      const cacheId = `${jwk.x}.${jwk.y}`;
      let deviceKey = deviceKeyCache.get(cacheId);
      if (!deviceKey) {
        deviceKey = await subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
        if (deviceKeyCache.size > 10000) deviceKeyCache.clear();
        deviceKeyCache.set(cacheId, deviceKey);
      }
      const tokenHash = encode64url(await subtle.digest("SHA-256", enc.encode(token)));
      const signature = decode64url(match[2]);
      let valid = false;
      for (const hostname of allowedHosts) {
        const message = enc.encode(`${PROOF_CONTEXT}\\n${hostname}\\n${match[1]}\\n${tokenHash}`);
        if (await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, deviceKey, signature, message)) {
          valid = true;
          break;
        }
      }
      if (!valid) return reject(401, "invalid_proof", "BitChord device proof is invalid for this hostname");
      return { ok: true, claims: { sub: claims.sub, ver: claims.ver, exp: claims.exp, sl: claims.sl } };
    } catch {
      return reject(401, "invalid_token", "Malformed BitChord credentials");
    }
  }

  function refusal(result) {
    const message = result.message.replace(/["\\]/g, "");
    return new Response(JSON.stringify({ error: "bitchord_auth", code: result.code, message: result.message }), {
      status: result.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "www-authenticate": `BitChord realm="${AUDIENCE}", error="${result.code}", error_description="${message}"`,
      },
    });
  }
  return { verify, refusal, hosts: allowedHosts };
}
