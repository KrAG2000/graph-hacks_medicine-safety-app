/**
 * Accounts and patient access.
 * Identity = the person using the app: a Caregiver, a Clinician, or a Patient managing their own medicines.
 * Access = a CARES_FOR edge from that person to the patient (a patient account has one to itself);
 * removing the edge revokes access. New edges come from access requests that a clinician approves.
 */
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
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

const ACCOUNT = "(u:Caregiver OR u:Clinician OR u:Patient)";

/** Returns {id, name, kind:'Caregiver'|'Clinician'|'Patient', role} or null. Same null for unknown user and wrong password. */
export async function login(graph, username, password) {
  const [u] = await run(
    graph,
    `MATCH (u) WHERE ${ACCOUNT} AND u.username = $username
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
 * Self-registration. role 'patient' creates a Patient that manages their own record (CARES_FOR itself);
 * role 'caregiver' creates a Caregiver with no patients. Either one then asks a clinician for access.
 * Clinician accounts are never self-registered (a clinician can approve medicines); an administrator creates them.
 */
export async function register(graph, { username, password, name, role = "caregiver", age }) {
  username = String(username || "").trim().toLowerCase();
  name = String(name || "").trim();
  password = String(password || "");
  if (!["patient", "caregiver"].includes(role))
    throw new AuthError(400, "invalid_role", "Register as a patient or a caregiver.");
  if (!/^[a-z0-9_.-]{3,32}$/.test(username))
    throw new AuthError(400, "invalid_username", "Username: 3-32 characters, letters, digits, . _ -");
  if (!name || name.length > 80) throw new AuthError(400, "invalid_name", "Name is required (max 80 characters).");
  if (password.length < 10 || password.length > 200)
    throw new AuthError(400, "weak_password", "Password must be 10-200 characters.");
  if (password.toLowerCase().includes(username))
    throw new AuthError(400, "weak_password", "Password must not contain the username.");
  const patient = role === "patient";
  age = Number(age);
  if (patient && !(Number.isInteger(age) && age >= 0 && age <= 120))
    throw new AuthError(400, "invalid_age", "Age is required for patients (it drives age-based safety rules).");
  const id = `${patient ? "pt" : "cg"}-${randomBytes(6).toString("hex")}`;
  const label = patient ? "Patient" : "Caregiver";
  // count() guard: FalkorDB lets `WITH x WHERE x IS NULL` through after a matching OPTIONAL MATCH.
  const [row] = await run(
    graph,
    `OPTIONAL MATCH (x) WHERE (x:Caregiver OR x:Clinician OR x:Patient) AND x.username = $username
     WITH count(x) AS taken WHERE taken = 0
     CREATE (u:${label} {id:$id, name:$name, username:$username, pass_hash:$hash, created:$ts${patient ? ", age:$age" : ""}})
     ${patient ? "CREATE (u)-[:CARES_FOR {since:$ts, via:'self'}]->(u)" : ""}
     RETURN u.id AS id`,
    { id, name, username, age: patient ? age : null, hash: hashPassword(password), ts: new Date().toISOString() },
  );
  if (!row) throw new AuthError(409, "username_taken", "That username is taken.");
  return { id, name, kind: label, role: label };
}

export async function getUser(graph, id) {
  const [u] = await run(
    graph,
    `MATCH (u {id:$id}) WHERE ${ACCOUNT}
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

/** Doctor directory: who can be asked for access. */
export async function clinicians(graph) {
  return run(
    graph,
    `MATCH (c:Clinician)
     OPTIONAL MATCH (c)-[:CARES_FOR]->(p:Patient)
     RETURN c.id AS id, c.name AS name, c.role AS role, count(p) AS patients ORDER BY c.name`,
  );
}

/**
 * Ask a clinician for access.
 * - A Patient asks a clinician to join their care team (kind 'self').
 * - A Caregiver asks a clinician for access to someone they look after (kind 'caregiver'). They only give a
 *   name; the clinician picks the matching patient from their own list, so caregivers can't search patients.
 */
export async function requestAccess(graph, user, { clinician_id, patient_name = "", relation = "", message = "" }) {
  if (user.kind === "Clinician") throw new AuthError(403, "forbidden", "Clinicians are added to care teams by approving requests.");
  const kind = user.kind === "Patient" ? "self" : "caregiver";
  patient_name = String(patient_name).trim();
  if (kind === "caregiver" && (patient_name.length < 2 || patient_name.length > 80))
    throw new AuthError(400, "patient_name_required", "Tell the doctor who you look after (their full name).");
  if (String(message).length > 500 || String(relation).length > 40)
    throw new AuthError(400, "too_long", "Message max 500 characters, relationship max 40.");
  const [c] = await run(
    graph,
    `MATCH (c:Clinician {id:$clinician}) OPTIONAL MATCH (c)-[e:CARES_FOR]->(:Patient {id:$user}) RETURN c.name AS name, count(e) AS already`,
    { clinician: String(clinician_id || ""), user: user.id },
  );
  if (!c) throw new AuthError(404, "not_found", "No such doctor.");
  if (c.already) throw new AuthError(409, "already_on_team", `${c.name} is already on your care team.`);
  const id = `req-${randomBytes(5).toString("hex")}`;
  const [row] = await run(
    graph,
    `MATCH (u {id:$user}), (c:Clinician {id:$clinician})
     OPTIONAL MATCH (u)<-[:FROM]-(dup:AccessRequest {status:'pending'})-[:TO]->(c)
     WITH u, c, count(dup) AS d WHERE d = 0
     CREATE (r:AccessRequest {id:$id, kind:$kind, status:'pending', patient_name:$patient_name, relation:$relation,
             message:$message, created:$ts})-[:FROM]->(u), (r)-[:TO]->(c)
     FOREACH (_ IN CASE WHEN $kind = 'self' THEN [1] ELSE [] END | CREATE (r)-[:FOR_PATIENT]->(u))
     RETURN r.id AS id`,
    {
      user: user.id, clinician: String(clinician_id), id, kind, ts: new Date().toISOString(),
      patient_name: kind === "self" ? user.name : patient_name, relation: String(relation).trim(), message: String(message).trim(),
    },
  );
  if (!row) throw new AuthError(409, "already_requested", `You already have a pending request with ${c.name}.`);
  return { id, kind, clinician: c.name, status: "pending" };
}

/** Requests the user has sent, newest first. */
export async function myRequests(graph, userId) {
  return run(
    graph,
    `MATCH (r:AccessRequest)-[:FROM]->({id:$user})
     MATCH (r)-[:TO]->(c:Clinician)
     OPTIONAL MATCH (r)-[:FOR_PATIENT]->(p:Patient)
     RETURN r.id AS id, r.kind AS kind, r.status AS status, r.created AS created, r.decided_at AS decided_at,
            r.note AS note, r.patient_name AS patient_name, c.name AS clinician, c.role AS clinician_role, p.name AS patient
     ORDER BY r.created DESC`,
    { user: userId },
  );
}

/** A clinician's inbox of pending requests. */
export async function inbox(graph, clinicianId) {
  return run(
    graph,
    `MATCH (r:AccessRequest {status:'pending'})-[:TO]->(:Clinician {id:$clinician})
     MATCH (r)-[:FROM]->(u)
     RETURN r.id AS id, r.kind AS kind, r.patient_name AS patient_name, r.relation AS relation, r.message AS message,
            r.created AS created, u.name AS from_name, labels(u)[0] AS from_kind, u.age AS from_age
     ORDER BY r.created`,
    { clinician: clinicianId },
  );
}

/**
 * Approve or decline a request addressed to this clinician.
 * Approving 'self' puts the clinician on the patient's care team. Approving 'caregiver' needs patient_id: one of
 * the clinician's own patients, which the caregiver then CARES_FOR.
 */
export async function decideRequest(graph, clinicianId, requestId, { decision, patient_id = null, note = "" }) {
  const ts = new Date().toISOString();
  note = String(note || "").trim();
  const [r] = await run(
    graph,
    `MATCH (r:AccessRequest {id:$id, status:'pending'})-[:TO]->(:Clinician {id:$clinician}) RETURN r.kind AS kind`,
    { id: String(requestId || ""), clinician: clinicianId },
  );
  if (!r) throw new AuthError(404, "not_found", "No pending request with that id in your inbox.");
  const base = { id: requestId, clinician: clinicianId, ts, note };
  if (decision === "rejected") {
    if (!note) throw new AuthError(400, "note_required", "Give a reason when declining.");
    await run(
      graph,
      `MATCH (r:AccessRequest {id:$id, status:'pending'})-[:TO]->(c:Clinician {id:$clinician})
       SET r.status = 'rejected', r.decided_at = $ts, r.note = $note
       CREATE (c)-[:DECIDED {decision:'rejected', ts:$ts}]->(r)`,
      base,
    );
    return { id: requestId, status: "rejected" };
  }
  if (decision !== "approved") throw new AuthError(400, "bad_decision", "decision: approved | rejected");
  const [row] = await run(
    graph,
    r.kind === "self"
      ? `MATCH (r:AccessRequest {id:$id, status:'pending'})-[:TO]->(c:Clinician {id:$clinician}), (r)-[:FROM]->(p:Patient)
         SET r.status = 'approved', r.decided_at = $ts, r.note = $note
         CREATE (c)-[:DECIDED {decision:'approved', ts:$ts}]->(r)
         MERGE (c)-[e:CARES_FOR]->(p) ON CREATE SET e.since = $ts, e.via = 'request'
         RETURN p.id AS patient_id, p.name AS patient`
      : `MATCH (r:AccessRequest {id:$id, status:'pending'})-[:TO]->(c:Clinician {id:$clinician}), (r)-[:FROM]->(u:Caregiver),
               (c)-[:CARES_FOR]->(p:Patient {id:$patient})
         SET r.status = 'approved', r.decided_at = $ts, r.note = $note
         CREATE (c)-[:DECIDED {decision:'approved', ts:$ts}]->(r), (r)-[:FOR_PATIENT]->(p)
         MERGE (u)-[e:CARES_FOR]->(p) ON CREATE SET e.since = $ts, e.via = 'request', e.approved_by = $clinician
         RETURN p.id AS patient_id, p.name AS patient`,
    { ...base, patient: patient_id },
  );
  if (!row)
    throw new AuthError(400, "pick_patient", "Pick which of your patients this caregiver looks after.");
  return { id: requestId, status: "approved", ...row };
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
