/**
 * Minimal HS256 JWT (RFC 7519) with node:crypto. Only HS256 is accepted: no "alg":"none", no algorithm switching.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const ISSUER = "med-safety-graph";
const HEADER = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");

export class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // 'invalid_token' | 'token_expired'
  }
}

const mac = (data, secret) => createHmac("sha256", secret).update(data).digest();

/** Sign claims; adds iss, iat, exp and a random jti unless given. expiresIn is in seconds. */
export function sign(claims, secret, { expiresIn, now = Date.now() }) {
  if (!secret) throw new Error("JWT secret missing");
  const iat = Math.floor(now / 1000);
  const body = { jti: randomBytes(12).toString("hex"), ...claims, iss: ISSUER, iat, exp: iat + expiresIn };
  const data = `${HEADER}.${Buffer.from(JSON.stringify(body)).toString("base64url")}`;
  return `${data}.${mac(data, secret).toString("base64url")}`;
}

/** Verify signature, issuer, expiry and (optionally) the token type claim. Returns the claims. */
export function verify(token, secret, { typ, now = Date.now(), leeway = 5, ignoreExpiry = false } = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new TokenError("invalid_token", "malformed token");
  const [h, p, s] = parts;
  let header, claims;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString());
    claims = JSON.parse(Buffer.from(p, "base64url").toString());
  } catch {
    throw new TokenError("invalid_token", "malformed token");
  }
  if (header?.alg !== "HS256") throw new TokenError("invalid_token", "unsupported algorithm");
  const want = mac(`${h}.${p}`, secret);
  const got = Buffer.from(s, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want))
    throw new TokenError("invalid_token", "bad signature");
  if (claims.iss !== ISSUER) throw new TokenError("invalid_token", "wrong issuer");
  if (typ && claims.typ !== typ) throw new TokenError("invalid_token", `expected a ${typ} token`);
  if (typeof claims.exp !== "number") throw new TokenError("invalid_token", "no expiry");
  if (!ignoreExpiry && Math.floor(now / 1000) > claims.exp + leeway)
    throw new TokenError("token_expired", "token expired");
  return claims;
}
