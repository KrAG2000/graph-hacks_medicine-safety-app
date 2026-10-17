/**
 * Live integration test. Runs only when FalkorDB is reachable (FALKORDB_HOST/PORT or FALKORDB_URL).
 * Uses a throwaway graph (meds_it_<pid>) seeded from seed.cypher and deletes it afterwards.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

const host = process.env.FALKORDB_HOST || "127.0.0.1";
const port = Number(process.env.FALKORDB_PORT || 6381);
const reachable = process.env.FALKORDB_URL
  ? true
  : await new Promise((res) => {
      const s = net.connect({ host, port, timeout: 500 }, () => {
        s.destroy();
        res(true);
      });
      s.on("error", () => res(false));
      s.on("timeout", () => {
        s.destroy();
        res(false);
      });
    });

const skip = reachable ? false : `FalkorDB not reachable at ${host}:${port}`;
process.env.FALKORDB_GRAPH = `meds_it_${process.pid}`;
let db, graph, m;

before(async () => {
  if (skip) return;
  const dbm = await import("../src/db.js");
  ({ db, graph } = await dbm.connect());
  for (const s of await dbm.seedStatements(new URL("../seed.cypher", import.meta.url)))
    await graph.query(s);
  m = {
    checker: await import("../src/agents/checker.js"),
    assistant: await import("../src/agents/assistant.js"),
    mem: await import("../src/memory.js"),
    auth: await import("../src/auth.js"),
    llm: await import("../src/llm.js"),
  };
});

after(async () => {
  if (skip || !graph) return;
  await graph.delete();
  await db.close();
});

const types = (c) => c.findings.map((f) => `${f.type}:${f.severity}`).sort();

test("Kamala + Advil: STOP for blood thinner and kidney disease; Tylenol already taken", { skip }, async () => {
  const c = await m.checker.checkMedication(graph, "Kamala", "Advil");
  assert.equal(c.level, "stop");
  assert.deepEqual(types(c), ["condition:major", "interaction:major", "interaction:moderate"]);
  assert.ok(c.findings.some((f) => f.with === "Coumadin" && f.contact === "Dr. Lena Ortiz"));
  assert.deepEqual(c.safer.map((s) => [s.drug, s.alreadyTaking]), [["Tylenol", true]]);
});

test("Kamala + NyQuil: CAUTION for doubled acetaminophen and age; suggests Mucinex", { skip }, async () => {
  const c = await m.checker.checkMedication(graph, "Kamala Iyer", "nyquil");
  assert.equal(c.level, "caution");
  assert.deepEqual(types(c), ["age:moderate", "duplicate:moderate"]);
  assert.deepEqual(c.safer.map((s) => s.drug), ["Mucinex"]);
});

test("Kamala + Amoxil: allergy via drug class", { skip }, async () => {
  const c = await m.checker.checkMedication(graph, "pt-kamala", "Amoxicillin");
  assert.equal(c.level, "stop");
  assert.equal(c.findings[0].type, "allergy");
  assert.match(c.findings[0].path, /Penicillins/);
  assert.deepEqual(c.safer.map((s) => [s.drug, s.level]), [["Zithromax", "monitor"]]);
});

test("Kamala + Biaxin: remembers the earlier rejection from the seed history", { skip }, async () => {
  const c = await m.checker.checkMedication(graph, "Kamala", "Biaxin");
  assert.equal(c.level, "stop");
  assert.equal(c.prior.length, 1);
  assert.equal(c.prior[0].reviewer, "Dr. Meera Rao");
  assert.match(c.summary, /decided NOT to start this/);
});

test("Ravi + Advil: same class as his Aleve, interacts with aspirin", { skip }, async () => {
  const c = await m.checker.checkMedication(graph, "Ravi", "Advil");
  assert.equal(c.level, "caution");
  assert.deepEqual(types(c), ["duplicate_class:moderate", "interaction:moderate"]);
});

test("Kamala + Mucinex: no conflicts, no alternatives needed", { skip }, async () => {
  const c = await m.checker.checkMedication(graph, "Kamala", "Mucinex");
  assert.equal(c.level, "no_known_issues");
  assert.equal(c.findings.length, 0);
});

test("unknown drug is reported, not treated as safe", { skip }, async () => {
  const c = await m.checker.checkMedication(graph, "Kamala", "Unobtainium");
  assert.match(c.error, /not in the graph/);
});

test("login: right password works, wrong password and unknown user look the same", { skip }, async () => {
  const u = await m.auth.login(graph, "Priya", "priya-demo");
  assert.deepEqual(u, { id: "cg-priya", name: "Priya Iyer", kind: "Caregiver", role: "Caregiver" });
  assert.equal(await m.auth.login(graph, "priya", "wrong"), null);
  assert.equal(await m.auth.login(graph, "nobody", "priya-demo"), null);
  const shah = await m.auth.login(graph, "shah", "shah-demo");
  assert.equal(shah.kind, "Clinician");
  assert.equal(shah.role, "Pharmacist");
});

test("sessions: only patients you care for", { skip }, async () => {
  const sam = await m.auth.login(graph, "sam", "sam-demo");
  assert.deepEqual((await m.auth.patientsFor(graph, sam.id)).map((p) => p.name), ["Ravi Iyer"]);
  assert.equal(await m.auth.openSession(graph, sam, "pt-kamala"), null);
  const s = await m.auth.openSession(graph, sam, "pt-ravi");
  assert.equal(s.patient.name, "Ravi Iyer");
  const [row] = (await graph.query(
    "MATCH (u)<-[:BY]-(:Session {id:$id})-[:ABOUT]->(p) RETURN u.name AS u, p.name AS p",
    { params: { id: s.id } },
  )).data;
  assert.deepEqual(row, { u: "Sam Iyer", p: "Ravi Iyer" });
});

test("review: only the logged-in clinician on the care team, only once", { skip }, async () => {
  const priya = await m.auth.login(graph, "priya", "priya-demo");
  const ortiz = await m.auth.login(graph, "ortiz", "ortiz-demo");
  const shah = await m.auth.login(graph, "shah", "shah-demo");
  const rao = await m.auth.login(graph, "rao", "rao-demo");
  const s = await m.auth.openSession(graph, priya, "pt-ravi");
  const ravi = await m.checker.checkMedication(graph, "pt-ravi", "Advil", { session: s.id });
  const pending = await m.mem.pendingChecks(graph, "pt-ravi");
  assert.ok(pending.some((p) => p.id === ravi.actionId && p.asked_by === "Priya Iyer"));

  assert.deepEqual(await m.mem.reviewAction(graph, ravi.actionId, priya.id, "approved"), []); // caregiver
  assert.deepEqual(await m.mem.reviewAction(graph, ravi.actionId, ortiz.id, "approved"), []); // not Ravi's team
  const ok = await m.mem.reviewAction(graph, ravi.actionId, shah.id, "rejected", "Use Tylenol instead");
  assert.equal(ok[0].patient, "Ravi Iyer");
  assert.deepEqual(await m.mem.reviewAction(graph, ravi.actionId, rao.id, "approved"), []); // already decided

  const again = await m.checker.checkMedication(graph, "pt-ravi", "Advil", { session: s.id });
  assert.equal(again.prior[0].reviewer, "Arjun Shah");
  assert.equal(again.prior[0].note, "Use Tylenol instead");
});

test("end to end (offline LLM): login -> scoped question -> pending check -> recall", { skip }, async () => {
  const priya = await m.auth.login(graph, "priya", "priya-demo");
  const s = await m.auth.openSession(graph, priya, "pt-kamala");
  const llm = m.llm.offline();
  const out = await m.assistant.ask(graph, llm, "Can she take NyQuil?", s);
  assert.match(out, /Kamala Iyer \+ NyQuil.*CAUTION/);
  const h = await m.mem.history(graph, { patient: "pt-kamala", drug: "NyQuil" });
  assert.ok(h.some((x) => x.status === "pending" && x.session === s.id && x.asked_by === "Priya Iyer"));
  // the answer is in the audit trail, linked to the patient
  const ans = await m.mem.history(graph, { patient: "pt-kamala" });
  assert.ok(ans.some((x) => x.kind === "answer" && x.session === s.id));
});
