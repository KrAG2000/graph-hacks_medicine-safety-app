/**
 * Login and patient access. Identity = the person using the app (a Caregiver or Clinician node).
 * Access = a CARES_FOR edge from that person to the patient; removing the edge revokes access.
 */
import { scryptSync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { run } from "./db.js";

export function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hex) return false;
  const want = Buffer.from(hex, "hex");
  const got = scryptSync(String(password), salt, want.length);
  return timingSafeEqual(want, got);
}

// Burn the same work for unknown usernames so response time doesn't reveal which usernames exist.
const DUMMY = hashPassword("dummy");

/** Returns {id, name, kind:'Caregiver'|'Clinician', role} or null. Same null for unknown user and wrong password. */
export async function login(graph, username, password) {
  const [u] = await run(
    graph,
    `MATCH (u) WHERE (u:Caregiver OR u:Clinician) AND u.username = $username
     RETURN u.id AS id, u.name AS name, labels(u)[0] AS kind, u.role AS role, u.pass_hash AS pass_hash
     LIMIT 1`,
    { username: String(username || "").trim().toLowerCase() },
  );
  const ok = verifyPassword(password, u?.pass_hash ?? DUMMY);
  if (!u || !ok) return null;
  return { id: u.id, name: u.name, kind: u.kind, role: u.role || u.kind };
}

/** Patients this user may act for. */
export async function patientsFor(graph, userId) {
  return run(
    graph,
    `MATCH (u {id:$user})-[:CARES_FOR]->(p:Patient)
     RETURN p.id AS id, p.name AS name, p.age AS age ORDER BY p.name`,
    { user: userId },
  );
}

/** Start a session pinned to one patient. Refuses (returns null) unless the user CARES_FOR that patient. */
export async function openSession(graph, user, patientId) {
  const id = `sess-${randomBytes(4).toString("hex")}`;
  const [row] = await run(
    graph,
    `MATCH (u {id:$user})-[:CARES_FOR]->(p:Patient {id:$patient})
     CREATE (s:Session {id:$id, started:$ts})-[:BY]->(u), (s)-[:ABOUT]->(p)
     RETURN s.id AS id, p.id AS patientId, p.name AS patientName, p.age AS patientAge`,
    { user: user.id, patient: patientId, id, ts: new Date().toISOString() },
  );
  if (!row) return null;
  return {
    id: row.id,
    user,
    patient: { id: row.patientId, name: row.patientName, age: row.patientAge },
  };
}

export class AuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Self-registration creates a Caregiver with no patients. Clinician accounts are never self-registered
 * (a clinician can approve medicines); they are provisioned by an administrator.
 */
export async function register(graph, { username, password, name }) {
  username = String(username || "").trim().toLowerCase();
  name = String(name || "").trim();
  password = String(password || "");
  if (!/^[a-z0-9_.-]{3,32}$/.test(username))
    throw new AuthError(400, "invalid_username", "Username: 3-32 characters, letters, digits, . _ -");
  if (!name || name.length > 80) throw new AuthError(400, "invalid_name", "Name is required (max 80 characters).");
  if (password.length < 10 || password.length > 200)
    throw new AuthError(400, "weak_password", "Password must be 10-200 characters.");
  if (password.toLowerCase().includes(username))
    throw new AuthError(400, "weak_password", "Password must not contain the username.");
  const id = `cg-${randomBytes(6).toString("hex")}`;
  // count() guard: FalkorDB lets `WITH x WHERE x IS NULL` through after a matching OPTIONAL MATCH.
  const [row] = await run(
    graph,
    `OPTIONAL MATCH (x) WHERE (x:Caregiver OR x:Clinician) AND x.username = $username
     WITH count(x) AS taken WHERE taken = 0
     CREATE (u:Caregiver {id:$id, name:$name, username:$username, pass_hash:$hash, created:$ts})
     RETURN u.id AS id`,
    { id, name, username, hash: hashPassword(password), ts: new Date().toISOString() },
  );
  if (!row) throw new AuthError(409, "username_taken", "That username is taken.");
  return { id, name, kind: "Caregiver", role: "Caregiver" };
}

export async function getUser(graph, id) {
  const [u] = await run(
    graph,
    `MATCH (u {id:$id}) WHERE u:Caregiver OR u:Clinician
     RETURN u.id AS id, u.name AS name, labels(u)[0] AS kind, u.role AS role`,
    { id },
  );
  return u ? { ...u, role: u.role || u.kind } : null;
}

/** A session is usable only by the user who opened it, and only while they still CARES_FOR its patient. */
export async function getSession(graph, user, sessionId) {
  if (!sessionId) return null;
  const [row] = await run(
    graph,
    `MATCH (u {id:$user})<-[:BY]-(s:Session {id:$sid})-[:ABOUT]->(p:Patient)<-[:CARES_FOR]-(u)
     RETURN s.id AS id, p.id AS pid, p.name AS pname, p.age AS page`,
    { user: user.id, sid: sessionId },
  );
  return row ? { id: row.id, user, patient: { id: row.pid, name: row.pname, age: row.page } } : null;
}

const hashCode = (code) => createHash("sha256").update(code.replace(/-/g, "").toUpperCase()).digest("hex");
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

/** A clinician on the patient's care team creates a one-time code that lets a caregiver join that care team. */
export async function createInvite(graph, clinicianId, patientId, { days = 7 } = {}) {
  const raw = Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % 32]).join("");
  const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
  const expires = new Date(Date.now() + days * 86400e3).toISOString();
  const [row] = await run(
    graph,
    `MATCH (c:Clinician {id:$clinician})-[:CARES_FOR]->(p:Patient {id:$patient})
     CREATE (c)-[:CREATED]->(:Invite {hash:$hash, expires:$expires, used:false, created:$ts})-[:FOR_PATIENT]->(p)
     RETURN p.name AS patient`,
    { clinician: clinicianId, patient: patientId, hash: hashCode(code), expires, ts: new Date().toISOString() },
  );
  if (!row) throw new AuthError(403, "forbidden", "Only a clinician on this patient's care team can invite.");
  return { code, expires, patient: row.patient };
}

/** A caregiver redeems a code once, before it expires, and joins the patient's care team. */
export async function acceptInvite(graph, userId, code) {
  const [row] = await run(
    graph,
    `MATCH (u:Caregiver {id:$user}), (i:Invite {hash:$hash, used:false})-[:FOR_PATIENT]->(p:Patient)
     WHERE i.expires > $now AND NOT (u)-[:CARES_FOR]->(p)
     SET i.used = true, i.used_at = $now
     CREATE (u)-[:REDEEMED]->(i), (u)-[:CARES_FOR {since:$now, via:'invite'}]->(p)
     RETURN p.id AS id, p.name AS name, p.age AS age`,
    { user: userId, hash: hashCode(String(code || "")), now: new Date().toISOString() },
  );
  if (!row) throw new AuthError(400, "invalid_invite", "That code is invalid, used, expired, or you already care for this patient.");
  return row;
}

/** Slows down password guessing: 5 failures per username+address locks that pair for 15 minutes. */
export class LoginThrottle {
  constructor({ max = 5, windowMs = 15 * 60e3 } = {}) {
    Object.assign(this, { max, windowMs, fails: new Map() });
  }
  key(username, addr) {
    return `${String(username).toLowerCase()}|${addr}`;
  }
  blocked(username, addr) {
    const f = this.fails.get(this.key(username, addr));
    return !!f && f.count >= this.max && Date.now() - f.first < this.windowMs;
  }
  fail(username, addr) {
    const k = this.key(username, addr);
    const f = this.fails.get(k);
    if (!f || Date.now() - f.first >= this.windowMs) this.fails.set(k, { count: 1, first: Date.now() });
    else f.count++;
  }
  success(username, addr) {
    this.fails.delete(this.key(username, addr));
  }
}
