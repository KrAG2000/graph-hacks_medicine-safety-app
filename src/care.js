/**
 * Editing a patient's record. Every change records who made it.
 * - Anyone on the care team (patient, caregiver, clinician) can add over-the-counter medicines and allergies.
 * - Only clinicians add prescriptions and conditions; patients and caregivers can stop only OTC medicines.
 * Callers have already checked that the user is on the patient's care team (the session).
 */
import { randomBytes } from "node:crypto";
import { run } from "./db.js";
import { named } from "./tools.js";
import { AuthError } from "./auth.js";

const fail = (status, code, message) => {
  throw new AuthError(status, code, message);
};

/** Pick-lists for the UI: medicines, conditions and possible allergens (drug classes and ingredients). */
export async function catalog(graph) {
  const [drugs, conditions, allergens] = await Promise.all([
    named(graph, "all_drugs", {}),
    run(graph, `MATCH (c:Condition) RETURN c.id AS id, c.name AS name ORDER BY c.name`),
    run(
      graph,
      `MATCH (x) WHERE x:DrugClass OR x:Ingredient
       RETURN x.id AS id, x.name AS name, labels(x)[0] AS kind ORDER BY kind, name`,
    ),
  ]);
  return { drugs, conditions, allergens };
}

export async function addMedication(graph, user, patientId, { drug, dose = "" }) {
  const [d] = await named(graph, "drug", { drug: String(drug || "") });
  if (!d?.id) fail(404, "unknown_drug", `"${drug}" is not in the graph yet, so it can't be added or checked.`);
  dose = String(dose).trim().slice(0, 60) || "as directed";
  const prescribed = user.kind === "Clinician";
  const [row] = await run(
    graph,
    `MATCH (p:Patient {id:$patient}), (d:Drug {id:$drug}), (u {id:$user})
     OPTIONAL MATCH (p)-[:HAS_RX]->(x:Rx {active:true})-[:OF]->(d)
     WITH p, d, u, count(x) AS dup WHERE dup = 0
     CREATE (p)-[:HAS_RX]->(rx:Rx {id:$id, dose:$dose, since:$ts, active:true, otc:$otc, added_by:$name})-[:OF]->(d),
            (u)-[:ADDED]->(rx)
     FOREACH (_ IN CASE WHEN $prescribed THEN [1] ELSE [] END | CREATE (u)-[:PRESCRIBED]->(rx))
     RETURN d.brand AS brand`,
    {
      patient: patientId, drug: d.id, user: user.id, id: `rx-${randomBytes(5).toString("hex")}`, dose,
      ts: new Date().toISOString(), otc: !prescribed, name: user.name, prescribed,
    },
  );
  if (!row) fail(409, "already_taking", `${d.brand || d.name} is already on the medicine list.`);
  return { drug: d.brand || d.name, dose, prescribed };
}

export async function stopMedication(graph, user, patientId, { drug }) {
  const [d] = await named(graph, "drug", { drug: String(drug || "") });
  if (!d?.id) fail(404, "unknown_drug", `"${drug}" is not in the graph.`);
  const [row] = await run(
    graph,
    `MATCH (:Patient {id:$patient})-[:HAS_RX]->(rx:Rx {active:true})-[:OF]->(d:Drug {id:$drug})
     WHERE $clinician OR rx.otc = true
     SET rx.active = false, rx.stopped = $ts, rx.stopped_by = $name
     RETURN d.brand AS brand`,
    { patient: patientId, drug: d.id, clinician: user.kind === "Clinician", ts: new Date().toISOString(), name: user.name },
  );
  if (!row) fail(403, "cannot_stop", "Only a clinician can stop a prescribed medicine (or it isn't on the list).");
  return { drug: row.brand };
}

export async function addCondition(graph, user, patientId, { condition_id }) {
  if (user.kind !== "Clinician") fail(403, "forbidden", "Only a clinician can record a diagnosis.");
  const [row] = await run(
    graph,
    `MATCH (p:Patient {id:$patient}), (c:Condition {id:$condition})
     MERGE (p)-[e:HAS_CONDITION]->(c) ON CREATE SET e.since = $ts, e.recorded_by = $name
     RETURN c.name AS name`,
    { patient: patientId, condition: String(condition_id || ""), ts: new Date().toISOString(), name: user.name },
  );
  if (!row) fail(404, "not_found", "Unknown condition.");
  return row;
}

export async function addAllergy(graph, user, patientId, { allergen_id, reaction = "" }) {
  const [row] = await run(
    graph,
    `MATCH (p:Patient {id:$patient}), (x {id:$allergen}) WHERE x:DrugClass OR x:Ingredient
     MERGE (p)-[a:ALLERGIC_TO]->(x) ON CREATE SET a.reaction = $reaction, a.reported_by = $name, a.since = $ts
     RETURN x.name AS name`,
    {
      patient: patientId, allergen: String(allergen_id || ""), reaction: String(reaction).trim().slice(0, 80) || "reaction on file",
      name: user.name, ts: new Date().toISOString(),
    },
  );
  if (!row) fail(404, "not_found", "Unknown allergen.");
  return row;
}
