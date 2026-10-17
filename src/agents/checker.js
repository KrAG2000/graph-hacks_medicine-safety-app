/**
 * Safety checker agent: patient + candidate drug -> graph walk -> findings -> recommendation.
 * The decision is deterministic (works without an LLM); an LLM, if given, only rewrites it in plain language.
 * Every check is recorded as a pending Action until a clinician on the care team reviews it.
 */
import { named } from "../tools.js";
import { history, recordAction } from "../memory.js";

const RANK = { info: 0, minor: 1, moderate: 2, major: 3 };

export const LEVELS = {
  stop: {
    label: "STOP",
    advice: "Do not start this until a clinician confirms it is safe.",
  },
  caution: {
    label: "CAUTION",
    advice: "Check with the pharmacist or prescriber before starting.",
  },
  monitor: {
    label: "OK WITH MONITORING",
    advice: "Probably fine, but tell the care team and watch for the effects listed.",
  },
  no_known_issues: {
    label: "NO CONFLICTS FOUND",
    advice:
      "Nothing in this graph conflicts. The graph is not a complete drug database, so still confirm with a pharmacist.",
  },
};

const step = (ingredient, via) =>
  via && via !== ingredient ? `${ingredient} → [${via}]` : ingredient;

/** Run every graph check for one patient + drug. Pure reads. */
export async function assess(graph, patientId, drug) {
  const p = { patient: patientId, drug: drug.id };
  const [ints, sameIng, sameClass, conds, ages, allergies] = await Promise.all([
    named(graph, "interactions", p),
    named(graph, "same_ingredient", p),
    named(graph, "same_class", p),
    named(graph, "conditions", p),
    named(graph, "age", p),
    named(graph, "allergies", p),
  ]);
  const label = drug.brand || drug.name;
  const findings = [];
  for (const a of allergies)
    findings.push({
      type: "allergy",
      severity: "major",
      message: `Allergic to ${a.allergen} (${a.reaction || "reaction on file"}).`,
      path: `${label} → ${step(a.ingredient, a.allergen)} ← ALLERGIC_TO ← patient`,
    });
  for (const i of ints)
    findings.push({
      type: "interaction",
      severity: i.severity,
      message: i.effect,
      with: i.current_drug,
      contact: i.prescriber || null,
      path: `${label} → ${step(i.new_ingredient, i.new_via)} ⟷ ${step(i.current_ingredient, i.current_via).split(" → ").reverse().join(" ← ")} ← ${i.current_drug}`,
    });
  for (const c of conds)
    findings.push({
      type: "condition",
      severity: c.severity,
      message: c.reason,
      path: `${label} → ${step(c.ingredient, c.via)} → CONTRAINDICATED_IN → ${c.condition}`,
    });
  for (const g of ages)
    findings.push({
      type: "age",
      severity: g.severity,
      message: g.reason,
      path: `${label} → ${step(g.ingredient, g.via)} → CAUTION_IN → ${g.group}`,
    });
  for (const s of sameIng)
    findings.push(
      s.same_drug
        ? {
            type: "already_taking",
            severity: "info",
            message: `Already on the medicine list.`,
            path: `${label} = ${s.current_drug}`,
          }
        : {
            type: "duplicate",
            severity: "moderate",
            message: `Same ingredient as ${s.current_drug}. ${s.note || ""}`.trim(),
            with: s.current_drug,
            path: `${label} → ${s.ingredient} ← ${s.current_drug}`,
          },
    );
  for (const s of sameClass)
    findings.push({
      type: "duplicate_class",
      severity: "moderate",
      message: `Same drug class (${s.class}) as ${s.current_drug}; usually only one is taken at a time.`,
      with: s.current_drug,
      path: `${label} → [${s.class}] ← ${s.current_drug}`,
    });
  return findings.sort((a, b) => RANK[b.severity] - RANK[a.severity]);
}

/** Highest severity decides the level. Pure; unit-tested. */
export function decide(findings) {
  const top = Math.max(0, ...findings.map((f) => RANK[f.severity] ?? 0));
  return top === 3 ? "stop" : top === 2 ? "caution" : top === 1 ? "monitor" : "no_known_issues";
}

/** Who to call: prescribers of the conflicting medicines first, then the pharmacist, then primary care. */
export function contacts(findings, team) {
  const out = [];
  const add = (name, why) => {
    if (name && !out.some((c) => c.name === name)) out.push({ name, why });
  };
  const prescribed = new Map();
  for (const f of findings)
    if (f.contact) prescribed.set(f.contact, [...new Set([...(prescribed.get(f.contact) || []), f.with])]);
  for (const [name, drugs] of prescribed) add(name, `prescribed ${drugs.join(", ")}`);
  for (const t of team) if (/pharmac/i.test(t.role)) add(t.name, t.role);
  if (findings.some((f) => ["allergy", "condition", "age"].includes(f.type)))
    for (const t of team) if (/primary/i.test(t.role)) add(t.name, t.role);
  return out;
}

/** Earlier clinician decisions about this drug for this patient. */
export function priorDecisions(hist) {
  return hist.filter(
    (h) => h.kind === "check" && ["approved", "rejected"].includes(h.status),
  );
}

async function saferOptions(graph, patientId, drug) {
  const alts = await named(graph, "alternatives", { drug: drug.id });
  const out = [];
  for (const alt of alts) {
    const f = await assess(graph, patientId, alt);
    const level = decide(f);
    if (level === "no_known_issues" || level === "monitor")
      out.push({
        drug: alt.brand || alt.name,
        indication: alt.indication,
        level,
        alreadyTaking: f.some((x) => x.type === "already_taking"),
        notes: f.filter((x) => x.severity !== "info").map((x) => x.message),
      });
  }
  return out;
}

/** Plain-text report built only from graph facts. */
export function report({ patient, drug, level, findings, who, prior, safer }) {
  const label = drug.brand && drug.brand !== drug.name ? `${drug.brand} (${drug.name})` : drug.name;
  const lines = [
    `${patient.name} + ${label}: ${LEVELS[level].label}. ${LEVELS[level].advice}`,
  ];
  for (const r of prior)
    lines.push(
      r.status === "rejected"
        ? `Earlier decision: ${r.reviewer} decided NOT to start this (${(r.reviewed_at || r.ts || "").slice(0, 10)}): "${r.note}" Do not raise it again without new information.`
        : `Earlier decision: ${r.reviewer} approved this (${(r.reviewed_at || r.ts || "").slice(0, 10)}): "${r.note}"`,
    );
  for (const f of findings.filter((x) => x.severity !== "info"))
    lines.push(`- [${f.severity.toUpperCase()}] ${f.message}\n    why: ${f.path}`);
  if (findings.some((f) => f.type === "already_taking"))
    lines.push(`- Note: ${patient.name} already takes this.`);
  if (who.length)
    lines.push(`Who to contact: ${who.map((c) => `${c.name} (${c.why})`).join("; ")}.`);
  if (safer.length)
    lines.push(
      `Options in the graph with no major conflicts: ${safer
        .map((s) => `${s.drug}${s.alreadyTaking ? " (already taking)" : ""}${s.level === "monitor" ? " (needs monitoring)" : ""}`)
        .join(", ")}. Ask the clinician before switching.`,
    );
  return lines.join("\n");
}

export async function checkMedication(
  graph,
  patientQuery,
  drugQuery,
  { session, llm = null, alternatives = true } = {},
) {
  const [patient] = await named(graph, "patient", { patient: patientQuery });
  if (!patient?.id) return { error: `patient "${patientQuery}" not found` };
  const [drug] = await named(graph, "drug", { drug: drugQuery });
  if (!drug?.id)
    return {
      error: `drug "${drugQuery}" is not in the graph. Unknown is not the same as safe: ask the pharmacist.`,
    };

  const findings = await assess(graph, patient.id, drug);
  const level = decide(findings);
  const team = await named(graph, "care_team", { patient: patient.id });
  const who = contacts(findings, team);
  const prior = priorDecisions(await history(graph, { patient: patient.id, drug: drug.id }));
  const safer =
    alternatives && (level === "stop" || level === "caution")
      ? await saferOptions(graph, patient.id, drug)
      : [];
  const summary = report({ patient, drug, level, findings, who, prior, safer });

  let explanation = null;
  if (llm && llm.name !== "offline") {
    try {
      const r = await llm.chat({
        system:
          "You explain medication safety findings to a family caregiver. Use plain language, 3-6 short sentences. " +
          "Use ONLY the facts in the report; do not add drugs, doses or effects that are not in it. " +
          "Keep the level (STOP/CAUTION/...) and the people to contact. Never say the medicine is safe; " +
          "end by saying a clinician must confirm.",
        messages: [{ role: "user", content: summary }],
        tools: [],
      });
      explanation = r.text || null;
    } catch (e) {
      explanation = null;
      findings.push({ type: "llm_error", severity: "info", message: e.message, path: "" });
    }
  }

  let actionId = null;
  if (session)
    actionId = await recordAction(graph, {
      session,
      agent: "checker",
      kind: "check",
      summary,
      patient: patient.id,
      drug: drug.id,
      status: "pending",
      level,
    });

  return { patient, drug, level, findings, contacts: who, prior, safer, summary, explanation, actionId };
}
