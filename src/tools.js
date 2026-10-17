/**
 * Graph tools the agents can call. Every query is a fixed, parameterised query.
 * The patient is never an LLM argument: dispatch() takes it from the logged-in session,
 * so a prompt like "show me Ravi's meds" from Kamala's session cannot reach Ravi.
 */
import { run } from "./db.js";

// `(x)-[:IN_CLASS*0..1]->(a)` means "a is the ingredient itself or its drug class",
// so one query catches both ingredient-level and class-level rules.
export const QUERIES = {
  patient: `MATCH (p:Patient)
    WHERE p.id = $patient OR toLower(p.name) = toLower($patient) OR toLower(p.name) STARTS WITH (toLower($patient) + ' ')
    OPTIONAL MATCH (p)-[:HAS_CONDITION]->(c:Condition)
    OPTIONAL MATCH (p)-[:ALLERGIC_TO]->(x)
    RETURN p.id AS id, p.name AS name, p.age AS age,
      collect(DISTINCT c.name) AS conditions, collect(DISTINCT x.name) AS allergies
    LIMIT 1`,
  drug: `MATCH (d:Drug)
    WHERE d.id = $drug OR toLower(d.name) = toLower($drug) OR toLower(d.brand) = toLower($drug)
    OPTIONAL MATCH (d)-[:CONTAINS]->(i:Ingredient)
    RETURN d.id AS id, d.name AS name, d.brand AS brand, collect(i.name) AS ingredients
    LIMIT 1`,
  current_meds: `MATCH (p:Patient {id:$patient})-[:HAS_RX]->(rx:Rx {active:true})-[:OF]->(d:Drug)
    OPTIONAL MATCH (doc:Clinician)-[:PRESCRIBED]->(rx)
    RETURN d.id AS drug_id, d.brand AS brand, d.name AS drug, rx.dose AS dose, rx.otc AS otc, doc.name AS prescriber, rx.added_by AS added_by`,
  care_team: `MATCH (c:Clinician)-[:CARES_FOR]->(:Patient {id:$patient})
    RETURN c.name AS name, c.role AS role`,
  interactions: `MATCH (:Patient {id:$patient})-[:HAS_RX]->(rx:Rx {active:true})-[:OF]->(cur:Drug)-[:CONTAINS]->(ci:Ingredient)
    MATCH (nd:Drug {id:$drug})-[:CONTAINS]->(ni:Ingredient)
    WHERE cur.id <> nd.id
    MATCH (ni)-[:IN_CLASS*0..1]->(a), (ci)-[:IN_CLASS*0..1]->(b)
    MATCH (a)-[x:INTERACTS_WITH]-(b)
    OPTIONAL MATCH (doc:Clinician)-[:PRESCRIBED]->(rx)
    RETURN DISTINCT ni.name AS new_ingredient, a.name AS new_via, cur.brand AS current_drug,
      ci.name AS current_ingredient, b.name AS current_via, x.severity AS severity, x.effect AS effect,
      doc.name AS prescriber`,
  same_ingredient: `MATCH (:Patient {id:$patient})-[:HAS_RX]->(:Rx {active:true})-[:OF]->(cur:Drug)-[:CONTAINS]->(i:Ingredient)<-[:CONTAINS]-(nd:Drug {id:$drug})
    RETURN DISTINCT cur.brand AS current_drug, i.name AS ingredient, i.note AS note, cur.id = nd.id AS same_drug`,
  same_class: `MATCH (:Patient {id:$patient})-[:HAS_RX]->(:Rx {active:true})-[:OF]->(cur:Drug)-[:CONTAINS]->(:Ingredient)-[:IN_CLASS]->(k:DrugClass {dup_check:true})<-[:IN_CLASS]-(:Ingredient)<-[:CONTAINS]-(nd:Drug {id:$drug})
    WHERE cur.id <> nd.id
    RETURN DISTINCT cur.brand AS current_drug, k.name AS class`,
  conditions: `MATCH (:Patient {id:$patient})-[:HAS_CONDITION]->(c:Condition)
    MATCH (:Drug {id:$drug})-[:CONTAINS]->(ni:Ingredient)-[:IN_CLASS*0..1]->(a)-[x:CONTRAINDICATED_IN]->(c)
    RETURN DISTINCT ni.name AS ingredient, a.name AS via, c.name AS condition, x.severity AS severity, x.reason AS reason`,
  age: `MATCH (p:Patient {id:$patient}), (:Drug {id:$drug})-[:CONTAINS]->(ni:Ingredient)-[:IN_CLASS*0..1]->(a)-[x:CAUTION_IN]->(g:AgeGroup)
    WHERE p.age >= g.min_age
    RETURN DISTINCT ni.name AS ingredient, a.name AS via, g.name AS group, x.severity AS severity, x.reason AS reason`,
  allergies: `MATCH (:Patient {id:$patient})-[al:ALLERGIC_TO]->(x)
    MATCH (:Drug {id:$drug})-[:CONTAINS]->(ni:Ingredient)-[:IN_CLASS*0..1]->(x)
    RETURN DISTINCT ni.name AS ingredient, x.name AS allergen, al.reaction AS reaction`,
  all_drugs: `MATCH (d:Drug) RETURN d.brand AS brand, d.name AS name ORDER BY d.brand`,
  alternatives: `MATCH (:Drug {id:$drug})-[:TREATS]->(n:Indication)<-[:TREATS]-(alt:Drug)
    RETURN DISTINCT alt.id AS id, alt.name AS name, alt.brand AS brand, n.name AS indication`,
};

/** Tool specs in a provider-neutral JSON-schema form. All are scoped to the session's patient. */
export const TOOL_SPECS = [
  {
    name: "patient_info",
    description:
      "Facts about the current patient from the graph: current medicines (with dose and prescriber), conditions, allergies and care team.",
    parameters: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["all", "medications", "conditions", "allergies", "care_team"],
        },
      },
    },
  },
  {
    name: "check_medication",
    description:
      "Run the medication safety check for the current patient and a drug they are considering (new prescription or over-the-counter). Returns findings with graph paths, who to contact, options with fewer conflicts and past clinician decisions. Always use this for 'is it safe' / 'can they take' questions.",
    parameters: {
      type: "object",
      properties: { drug: { type: "string", description: "drug name or brand" } },
      required: ["drug"],
    },
  },
  {
    name: "recall_history",
    description:
      "Earlier safety checks and clinician decisions for the current patient, optionally for one drug.",
    parameters: {
      type: "object",
      properties: { drug: { type: "string" } },
    },
  },
];

/** patient_info implementation; patientId comes from the session. */
export async function patientInfo(graph, patientId, topic = "all") {
  const [p] = await named(graph, "patient", { patient: patientId });
  const out = {};
  if (topic === "all" || topic === "medications")
    out.medications = await named(graph, "current_meds", { patient: patientId });
  if (topic === "all" || topic === "conditions") out.conditions = p?.conditions ?? [];
  if (topic === "all" || topic === "allergies") out.allergies = p?.allergies ?? [];
  if (topic === "all" || topic === "care_team")
    out.care_team = await named(graph, "care_team", { patient: patientId });
  return out;
}

export async function named(graph, name, params) {
  if (!QUERIES[name]) throw new Error(`unknown query ${name}`);
  return run(graph, QUERIES[name], params);
}
