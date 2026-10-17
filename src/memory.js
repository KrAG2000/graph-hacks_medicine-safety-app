/** Cross-session memory and clinician sign-off, stored in the graph as Session, Action and REVIEWED. */
import { randomUUID } from "node:crypto";
import { run } from "./db.js";

// Sessions are opened by auth.openSession(), which pins each one to a logged-in user and one patient.

/**
 * Record an Action linked to the session and, when they exist, a patient and drug.
 * status: 'info' for answers, 'pending' for safety checks until a clinician reviews them.
 */
export async function recordAction(
  graph,
  {
    session,
    agent,
    kind,
    summary,
    patient = null,
    drug = null,
    status = "info",
    level = null,
  },
) {
  const id = `act-${randomUUID().slice(0, 8)}`;
  await run(
    graph,
    `MATCH (s:Session {id:$session})
     CREATE (a:Action {id:$id, agent:$agent, kind:$kind, summary:$summary, status:$status, level:$level, ts:$ts})-[:IN_SESSION]->(s)
     WITH a
     OPTIONAL MATCH (p:Patient {id:$patient})
     FOREACH (_ IN CASE WHEN p IS NULL THEN [] ELSE [1] END | CREATE (a)-[:FOR_PATIENT]->(p))
     WITH a
     OPTIONAL MATCH (d:Drug {id:$drug})
     FOREACH (_ IN CASE WHEN d IS NULL THEN [] ELSE [1] END | CREATE (a)-[:ON_DRUG]->(d))
     RETURN a.id AS id`,
    {
      session,
      id,
      agent,
      kind,
      summary: String(summary).slice(0, 1000),
      status,
      level: level ?? "",
      ts: new Date().toISOString(),
      patient: patient ?? "",
      drug: drug ?? "",
    },
  );
  return id;
}

/**
 * The logged-in clinician decides on a pending check: 'approved' (OK to start) or 'rejected' (do not start).
 * The graph enforces who may decide: only a Clinician on that patient's care team, only while pending,
 * and (when patientId is given, as the API does) only for the patient of the clinician's current session.
 * Returns [] otherwise (wrong id, caregiver, not on the care team, or already decided).
 */
export async function reviewAction(graph, actionId, clinicianId, decision, note = "", patientId = null) {
  if (!["approved", "rejected"].includes(decision))
    throw new Error(`decision must be approved or rejected, got ${decision}`);
  return run(
    graph,
    `MATCH (a:Action {id:$id, status:'pending'})-[:FOR_PATIENT]->(p:Patient)<-[:CARES_FOR]-(c:Clinician {id:$clinician})
     WHERE $patient IS NULL OR p.id = $patient
     SET a.status = $decision
     CREATE (c)-[:REVIEWED {decision:$decision, note:$note, ts:$ts}]->(a)
     RETURN a.id AS id, p.name AS patient`,
    { id: actionId, clinician: clinicianId, decision, note, ts: new Date().toISOString(), patient: patientId },
  );
}

/** Checks for one patient still waiting for a clinician. */
export async function pendingChecks(graph, patientId) {
  return run(
    graph,
    `MATCH (a:Action {kind:'check', status:'pending'})-[:FOR_PATIENT]->(:Patient {id:$patient})
     OPTIONAL MATCH (a)-[:ON_DRUG]->(d:Drug)
     OPTIONAL MATCH (a)-[:IN_SESSION]->(:Session)-[:BY]->(u)
     RETURN a.id AS id, d.brand AS drug, a.level AS level, a.ts AS ts, u.name AS asked_by, a.summary AS summary
     ORDER BY a.ts DESC`,
    { patient: patientId },
  );
}

/** Earlier checks and decisions for a patient (id), optionally one drug (id, name or brand). */
export async function history(graph, { patient = "", drug = "" } = {}) {
  return run(
    graph,
    `MATCH (a:Action)-[:FOR_PATIENT]->(p:Patient {id:$patient})
     OPTIONAL MATCH (a)-[:ON_DRUG]->(d:Drug)
     OPTIONAL MATCH (a)-[:IN_SESSION]->(s:Session)
     OPTIONAL MATCH (s)-[:BY]->(u)
     OPTIONAL MATCH (c:Clinician)-[r:REVIEWED]->(a)
     WITH a, p, d, s, u, c, r
     WHERE $drug = '' OR d.id = $drug OR toLower(d.name) = toLower($drug) OR toLower(d.brand) = toLower($drug)
     RETURN a.id AS id, a.kind AS kind, a.level AS level, a.status AS status, a.summary AS summary, a.ts AS ts,
            s.id AS session, u.name AS asked_by, p.name AS patient, d.brand AS drug, c.name AS reviewer, r.note AS note, r.ts AS reviewed_at
     ORDER BY a.ts DESC LIMIT 20`,
    { patient, drug },
  );
}
