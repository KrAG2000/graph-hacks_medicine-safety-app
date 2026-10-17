/**
 * Access + refresh tokens.
 * - Access token (15 min): who you are and, once you pick a patient, which session/patient you act for.
 * - Refresh token (7 days): rotated on every use. Each one is a (:RefreshToken {jti, family})-[:ISSUED_TO]->(user)
 *   node, so the server can revoke it. Presenting an already-used refresh token means it was copied:
 *   the whole family (that login) is revoked.
 */
import { randomBytes } from "node:crypto";
import { run } from "./db.js";
import { sign, verify, TokenError } from "./jwt.js";

export const ACCESS_TTL = Number(process.env.JWT_ACCESS_TTL || 15 * 60);
export const REFRESH_TTL = Number(process.env.JWT_REFRESH_TTL || 7 * 24 * 3600);

let warned = false;
function secrets() {
  let access = process.env.JWT_ACCESS_SECRET;
  let refresh = process.env.JWT_REFRESH_SECRET;
  if (!access || !refresh) {
    // Dev fallback: random per process, so tokens stop working when the server restarts.
    if (!warned) {
      console.warn("JWT_ACCESS_SECRET/JWT_REFRESH_SECRET not set: using random secrets for this process only.");
      warned = true;
    }
    access = process.env.JWT_ACCESS_SECRET ||= randomBytes(32).toString("hex");
    refresh = process.env.JWT_REFRESH_SECRET ||= randomBytes(32).toString("hex");
  }
  if (access.length < 32 || refresh.length < 32) throw new Error("JWT secrets must be at least 32 characters");
  if (access === refresh) throw new Error("JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ");
  return { access, refresh };
}

export function accessToken(user, session = null) {
  return sign(
    {
      typ: "access",
      sub: user.id,
      name: user.name,
      kind: user.kind,
      role: user.role,
      sid: session?.id ?? null,
      pid: session?.patient?.id ?? null,
    },
    secrets().access,
    { expiresIn: ACCESS_TTL },
  );
}

/** New refresh token in a family (a new family per login). */
async function refreshToken(graph, user, family = randomBytes(8).toString("hex")) {
  const jti = randomBytes(16).toString("hex");
  const token = sign({ typ: "refresh", sub: user.id, fam: family, jti }, secrets().refresh, { expiresIn: REFRESH_TTL });
  await run(
    graph,
    `MATCH (u {id:$user}) WHERE u:Caregiver OR u:Clinician OR u:Patient
     CREATE (:RefreshToken {jti:$jti, family:$family, revoked:false, created:$ts, exp:$exp})-[:ISSUED_TO]->(u)`,
    { user: user.id, jti, family, ts: new Date().toISOString(), exp: Math.floor(Date.now() / 1000) + REFRESH_TTL },
  );
  return token;
}

const pair = async (graph, user, session, family) => ({
  token_type: "Bearer",
  access_token: accessToken(user, session),
  expires_in: ACCESS_TTL,
  refresh_token: await refreshToken(graph, user, family),
  refresh_expires_in: REFRESH_TTL,
});

export const issueTokens = (graph, user, session = null) => pair(graph, user, session);

async function revokeFamily(graph, family) {
  await run(graph, `MATCH (t:RefreshToken {family:$family}) SET t.revoked = true`, { family });
}

/**
 * Rotate: the old refresh token is marked used in the same query that checks it, so two concurrent
 * refreshes with one token can't both succeed. loadUser/loadSession re-check the account and patient access.
 */
export async function rotate(graph, token, { loadUser, loadSession }) {
  if (!token) throw new TokenError("invalid_token", "not signed in");
  const c = verify(token, secrets().refresh, { typ: "refresh" });
  const [ok] = await run(
    graph,
    `MATCH (t:RefreshToken {jti:$jti, revoked:false})-[:ISSUED_TO]->({id:$sub})
     SET t.revoked = true, t.used_at = $ts
     RETURN t.family AS family`,
    { jti: c.jti, sub: c.sub, ts: new Date().toISOString() },
  );
  if (!ok) {
    const [seen] = await run(graph, `MATCH (t:RefreshToken {jti:$jti}) RETURN t.family AS family`, { jti: c.jti });
    if (seen) await revokeFamily(graph, seen.family); // reuse of a rotated token: assume theft, end that login
    throw new TokenError("invalid_token", seen ? "refresh token already used; please log in again" : "unknown refresh token");
  }
  const user = await loadUser(c.sub);
  if (!user) throw new TokenError("invalid_token", "account no longer exists");
  const session = await loadSession(user);
  return { user, session, tokens: await pair(graph, user, session, ok.family) };
}

/** Logout: revoke the whole login (family). Accepts expired refresh tokens; the signature must still be valid. */
export async function revoke(graph, token) {
  if (!token) throw new TokenError("invalid_token", "not signed in");
  const c = verify(token, secrets().refresh, { typ: "refresh", ignoreExpiry: true });
  await revokeFamily(graph, c.fam);
}

export function verifyAccess(token) {
  return verify(token, secrets().access, { typ: "access" });
}
