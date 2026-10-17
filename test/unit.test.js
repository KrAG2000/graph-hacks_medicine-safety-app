import { test } from "node:test";
import assert from "node:assert/strict";
import { mockGraph } from "./mockGraph.js";
import { decide, contacts, priorDecisions, report } from "../src/agents/checker.js";
import { offline } from "../src/llm.js";
import { ask, dispatch, systemPrompt } from "../src/agents/assistant.js";
import { hashPassword, verifyPassword } from "../src/auth.js";
import { reviewAction } from "../src/memory.js";

test("decide: highest severity wins", () => {
  assert.equal(decide([]), "no_known_issues");
  assert.equal(decide([{ severity: "info" }]), "no_known_issues");
  assert.equal(decide([{ severity: "minor" }]), "monitor");
  assert.equal(decide([{ severity: "minor" }, { severity: "moderate" }]), "caution");
  assert.equal(decide([{ severity: "moderate" }, { severity: "major" }]), "stop");
});

test("contacts: prescribers first with all their drugs, then pharmacist, then primary care", () => {
  const team = [
    { name: "Dr. Meera Rao", role: "Primary care physician" },
    { name: "Arjun Shah", role: "Pharmacist" },
  ];
  const c = contacts(
    [
      { type: "interaction", contact: "Dr. Lena Ortiz", with: "Lipitor" },
      { type: "interaction", contact: "Dr. Lena Ortiz", with: "Coumadin" },
      { type: "condition" },
    ],
    team,
  );
  assert.deepEqual(
    c.map((x) => x.name),
    ["Dr. Lena Ortiz", "Arjun Shah", "Dr. Meera Rao"],
  );
  assert.equal(c[0].why, "prescribed Lipitor, Coumadin");
});

test("priorDecisions keeps only reviewed checks", () => {
  const h = [
    { kind: "check", status: "pending" },
    { kind: "check", status: "rejected" },
    { kind: "answer", status: "info" },
  ];
  assert.deepEqual(priorDecisions(h), [{ kind: "check", status: "rejected" }]);
});

test("report: shows earlier rejection, reasons with paths, contacts", () => {
  const text = report({
    patient: { name: "Kamala Iyer" },
    drug: { name: "Clarithromycin", brand: "Biaxin" },
    level: "stop",
    findings: [{ severity: "major", message: "muscle damage", path: "Biaxin → clarithromycin ⟷ atorvastatin ← Lipitor" }],
    who: [{ name: "Dr. Lena Ortiz", why: "prescribed Lipitor" }],
    prior: [{ status: "rejected", reviewer: "Dr. Meera Rao", note: "use azithromycin", ts: "2026-09-02T10:00:00Z" }],
    safer: [{ drug: "Zithromax", level: "monitor" }],
  });
  assert.match(text, /^Kamala Iyer \+ Biaxin \(Clarithromycin\): STOP/);
  assert.match(text, /decided NOT to start this \(2026-09-02\)/);
  assert.match(text, /why: Biaxin → clarithromycin ⟷ atorvastatin ← Lipitor/);
  assert.match(text, /Zithromax \(needs monitoring\)/);
});

test("passwords: scrypt hash verifies, wrong or malformed fails", () => {
  const h = hashPassword("priya-demo");
  assert.match(h, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.ok(verifyPassword("priya-demo", h));
  assert.equal(verifyPassword("guess", h), false);
  assert.equal(verifyPassword("x", "plaintext"), false);
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

const SESSION = {
  id: "sess-1",
  user: { id: "cg-priya", name: "Priya Iyer", kind: "Caregiver", role: "Caregiver" },
  patient: { id: "pt-kamala", name: "Kamala Iyer", age: 78 },
};

test("offline router never picks the patient; the session does", async () => {
  const llm = offline();
  const r1 = await llm.chat({ messages: [{ role: "user", content: "Can mom take Advil?" }] });
  assert.equal(r1.toolCalls[0].name, "check_medication");
  assert.deepEqual(r1.toolCalls[0].args, { drug: "advil" });
  const r2 = await llm.chat({ messages: [{ role: "user", content: "What did we decide about NyQuil?" }] });
  assert.equal(r2.toolCalls[0].name, "recall_history");
  assert.deepEqual(r2.toolCalls[0].args, { drug: "nyquil" });
  const r3 = await llm.chat({ messages: [{ role: "user", content: "Who is on her care team?" }] });
  assert.deepEqual(r3.toolCalls[0].args, { topic: "care_team" });
});

test("system prompt pins the session to one patient", () => {
  const p = systemPrompt(SESSION);
  assert.match(p, /Priya Iyer/);
  assert.match(p, /ONE patient: Kamala Iyer, age 78/);
});

test("dispatch ignores a patient smuggled into tool args", async () => {
  const graph = mockGraph();
  await dispatch(graph, offline(), { name: "recall_history", args: { patient: "pt-ravi", drug: "" } }, SESSION);
  await dispatch(graph, offline(), { name: "patient_info", args: { patient: "pt-ravi", topic: "care_team" } }, SESSION);
  assert.ok(graph.calls.length > 0);
  for (const c of graph.calls) assert.equal(c.params.patient, "pt-kamala");
});

test("ask refuses to run without a logged-in session", async () => {
  await assert.rejects(ask(mockGraph(), offline(), "hi", null), /log in/);
});

test("unknown tools are reported back to the model, not run", async () => {
  const graph = mockGraph();
  const llm = {
    name: "fake",
    calls: 0,
    async chat({ messages }) {
      if (this.calls++ === 0)
        return { text: "", toolCalls: [{ id: "1", name: "run_cypher", args: { cypher: "MATCH (n) DETACH DELETE n" } }] };
      return { text: messages.at(-1).content, toolCalls: [] };
    },
  };
  const out = await ask(graph, llm, "delete everything", SESSION);
  assert.match(out, /unknown tool run_cypher/);
  assert.ok(graph.calls.every((c) => !/DELETE/.test(c.cypher)));
});

test("reviewAction only accepts approved/rejected", async () => {
  await assert.rejects(reviewAction(mockGraph(), "act-1", "Dr. X", "maybe"), /approved or rejected/);
});
