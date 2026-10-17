/**
 * Live API test: real HTTP server + FalkorDB, throwaway graph (meds_api_<pid>), deleted afterwards.
 * Skipped when FalkorDB is not reachable.
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

process.env.FALKORDB_GRAPH = `meds_api_${process.pid}`;
process.env.JWT_ACCESS_SECRET = "test-access-secret-".padEnd(40, "x");
process.env.JWT_REFRESH_SECRET = "test-refresh-secret-".padEnd(40, "y");

let db, graph, server, base, Client, sign;

before(async () => {
  if (skip) return;
  const dbm = await import("../src/db.js");
  ({ db, graph } = await dbm.connect());
  for (const s of await dbm.seedStatements(new URL("../seed.cypher", import.meta.url))) await graph.query(s);
  const { startServer } = await import("../src/server.js");
  const { offline } = await import("../src/llm.js");
  ({ Client } = await import("../src/client.js"));
  ({ sign } = await import("../src/jwt.js"));
  server = await startServer({ graph, llm: offline(), port: 0 });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (skip || !graph) return;
  await new Promise((r) => server.close(r));
  await graph.delete();
  await db.close();
});

const post = (path, body, token) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
const get = (path, token) =>
  fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));
const rejects = (p, code) => assert.rejects(p, (e) => e.code === code);

test("register: validation, duplicate usernames, clinicians cannot self-register", { skip }, async () => {
  assert.equal((await post("/auth/register", { username: "x", password: "long-enough-pw", name: "X" })).body.error.code, "invalid_username");
  assert.equal((await post("/auth/register", { username: "maya", password: "short", name: "Maya" })).body.error.code, "weak_password");
  assert.equal((await post("/auth/register", { username: "maya", password: "maya-12345678", name: "Maya" })).body.error.code, "weak_password");
  assert.equal((await post("/auth/register", { username: "shah", password: "a-long-password", name: "Fake" })).status, 409);
  const r = await post("/auth/register", { username: "maya", password: "correct-horse-1", name: "Maya Shah", kind: "Clinician" });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.kind, "Caregiver"); // extra fields ignored
  assert.ok(r.body.access_token && r.body.refresh_token);
});

test("protected routes need a valid Bearer token", { skip }, async () => {
  assert.equal((await get("/me")).status, 401);
  assert.equal((await get("/me", "garbage")).body.error.code, "invalid_token");
  const wrongKey = sign({ typ: "access", sub: "cg-priya" }, "z".repeat(40), { expiresIn: 60 });
  assert.equal((await get("/me", wrongKey)).body.error.code, "invalid_token");
  const login = await post("/auth/login", { username: "priya", password: "priya-demo" });
  // a refresh token is not accepted as an access token
  assert.equal((await get("/me", login.body.refresh_token)).status, 401);
  assert.equal((await get("/me", login.body.access_token)).body.user.name, "Priya Iyer");
});

test("patient registration: own record, age required, then asks a doctor who approves", { skip }, async () => {
  assert.equal((await post("/auth/register", { role: "patient", username: "ida", password: "a-long-password", name: "Ida" })).body.error.code, "invalid_age");
  assert.equal((await post("/auth/register", { role: "doctor", username: "ida", password: "a-long-password", name: "Ida" })).body.error.code, "invalid_role");
  const ida = new Client(base);
  const u = await ida.register("ida", "a-long-password", "Ida Berg", { role: "patient", age: 70 });
  assert.equal(u.kind, "Patient");
  const { patients } = await ida.me();
  assert.deepEqual(patients.map((p) => p.name), ["Ida Berg"]); // their own record only
  await ida.openSession(u.id);
  assert.deepEqual((await ida.patient()).care_team, []);

  const { clinicians } = await ida.clinicians();
  const okafor = clinicians.find((c) => c.name === "Dr. Samuel Okafor");
  assert.equal(okafor.patients, 0);
  await rejects(ida.requestAccess("cl-nope"), "not_found");
  assert.equal((await ida.requestAccess(okafor.id, { message: "Diabetes follow-up" })).request.status, "pending");
  await rejects(ida.requestAccess(okafor.id), "already_requested");

  const doc = new Client(base);
  await doc.login("okafor", "okafor-demo");
  await rejects(doc.requestAccess(okafor.id), "forbidden"); // clinicians don't request
  const { inbox } = await doc.requests();
  assert.equal(inbox.length, 1);
  assert.deepEqual([inbox[0].from_name, inbox[0].from_kind, inbox[0].from_age, inbox[0].kind], ["Ida Berg", "Patient", 70, "self"]);
  await rejects(doc.decideRequest(inbox[0].id, "rejected", { note: "" }), "note_required");
  const rao = new Client(base);
  await rao.login("rao", "rao-demo");
  await rejects(rao.decideRequest(inbox[0].id, "approved"), "not_found"); // not addressed to Dr. Rao
  const ok = await doc.decideRequest(inbox[0].id, "approved", { note: "Welcome" });
  assert.equal(ok.patient, "Ida Berg");
  await rejects(doc.decideRequest(inbox[0].id, "approved"), "not_found"); // decided once
  assert.deepEqual((await ida.patient()).care_team.map((c) => c.name), ["Dr. Samuel Okafor"]);
  const mine = (await ida.requests()).mine;
  assert.deepEqual([mine[0].status, mine[0].note, mine[0].patient], ["approved", "Welcome", "Ida Berg"]);
  await rejects(ida.requestAccess(okafor.id), "already_on_team");
  // the doctor now has her, and can record a diagnosis and prescribe
  assert.ok((await doc.me()).patients.some((p) => p.name === "Ida Berg"));
});

test("caregiver request: doctor picks one of their own patients to link", { skip }, async () => {
  const kai = new Client(base);
  await kai.register("kai", "looks-after-ravi-26", "Kai Wong");
  assert.deepEqual((await kai.me()).patients, []);
  await rejects(kai.openSession("pt-ravi"), "forbidden");
  await rejects(kai.requestAccess("cl-rao", {}), "patient_name_required");
  const { request } = await kai.requestAccess("cl-rao", { patient_name: "Ravi Iyer", relation: "neighbour" });

  const rao = new Client(base);
  await rao.login("rao", "rao-demo");
  const { inbox, patients } = await rao.requests();
  const q = inbox.find((x) => x.id === request.id);
  assert.equal(q.patient_name, "Ravi Iyer");
  assert.ok(patients.some((p) => p.id === "pt-ravi"));
  await rejects(rao.decideRequest(q.id, "approved"), "pick_patient");
  await rejects(rao.decideRequest(q.id, "approved", { patient_id: "pt-lena-unknown" }), "pick_patient");
  const ortiz = new Client(base);
  await ortiz.login("ortiz", "ortiz-demo");
  await rejects(ortiz.decideRequest(q.id, "approved", { patient_id: "pt-kamala" }), "not_found"); // not her request
  assert.equal((await rao.decideRequest(q.id, "approved", { patient_id: "pt-ravi" })).patient, "Ravi Iyer");
  await kai.openSession("pt-ravi");
  assert.match((await kai.ask("Can he take Advil?")).answer, /Ravi Iyer \+ Advil.*CAUTION/);

  // a declined request explains why and grants nothing
  const zed = new Client(base);
  await zed.register("zed", "another-long-pass", "Zed");
  const r2 = (await zed.requestAccess("cl-rao", { patient_name: "Kamala Iyer" })).request;
  await rao.decideRequest(r2.id, "rejected", { note: "Kamala's family hasn't mentioned you." });
  assert.equal((await zed.requests()).mine[0].status, "rejected");
  assert.deepEqual((await zed.me()).patients, []);
});

test("record editing: OTC by family, prescriptions and conditions by clinicians, who-did-it recorded", { skip }, async () => {
  const sam = new Client(base);
  await sam.login("sam", "sam-demo");
  await sam.openSession("pt-ravi");
  await rejects(sam.addMedication("Unobtainium"), "unknown_drug");
  const added = await sam.addMedication("Mucinex", "600 mg twice daily");
  assert.deepEqual([added.drug, added.prescribed], ["Mucinex", false]);
  await rejects(sam.addMedication("Mucinex"), "already_taking");
  await rejects(sam.addCondition("cond-asthma"), "forbidden");
  await rejects(sam.stopMedication("Norvasc"), "cannot_stop"); // prescribed: clinicians only
  assert.equal((await sam.addAllergy("cls-macrolide", "rash")).name, "Macrolide antibiotics");
  const meds = (await sam.patient()).medications;
  const muc = meds.find((m) => m.brand === "Mucinex");
  assert.deepEqual([muc.otc, muc.added_by, muc.prescriber], [true, "Sam Iyer", null]);
  assert.match((await sam.check("Zithromax")).findings.map((f) => f.type).join(), /allergy/);
  assert.equal((await sam.stopMedication("Mucinex")).drug, "Mucinex");

  const rao = new Client(base);
  await rao.login("rao", "rao-demo");
  await rao.openSession("pt-ravi");
  await rao.addCondition("cond-ulcer");
  const rx = await rao.addMedication("Zithromax", "250 mg daily");
  assert.equal(rx.prescribed, true);
  const p = await rao.patient();
  assert.ok(p.conditions.includes("Stomach ulcer"));
  assert.equal(p.medications.find((m) => m.brand === "Zithromax").prescriber, "Dr. Meera Rao");
  assert.equal((await rao.check("Advil")).level, "stop"); // NSAID + the ulcer just recorded
});

test("session scope: the access token is pinned to one patient; access is re-checked every request", { skip }, async () => {
  const sam = new Client(base);
  await sam.login("sam", "sam-demo");
  await rejects(sam.openSession("pt-kamala"), "forbidden");
  await rejects(sam.ask("hi"), "no_session");
  await sam.openSession("pt-ravi");
  assert.equal((await sam.patient()).patient.name, "Ravi Iyer");

  // Remove Sam from Ravi's care team: his still-unexpired token stops working immediately.
  await graph.query("MATCH (:Caregiver {id:'cg-sam'})-[r:CARES_FOR]->(:Patient {id:'pt-ravi'}) DELETE r");
  await rejects(sam.patient(), "access_revoked");
  assert.equal(sam.creds.session, null);
  await graph.query("MATCH (u:Caregiver {id:'cg-sam'}), (p:Patient {id:'pt-ravi'}) CREATE (u)-[:CARES_FOR]->(p)");
});

test("reviews: clinicians only, and only for their patients", { skip }, async () => {
  const priya = new Client(base);
  await priya.login("priya", "priya-demo");
  await priya.openSession("pt-kamala");
  const c = await priya.check("NyQuil");
  await rejects(priya.review(c.actionId, "approved"), "forbidden");
  await rejects(priya.pending(), "forbidden");

  const shah = new Client(base);
  await shah.login("shah", "shah-demo");
  await shah.openSession("pt-ravi");
  await rejects(shah.review(c.actionId, "approved", "ok"), "not_found"); // Kamala's check from a Ravi session
  await shah.openSession("pt-kamala");
  assert.ok((await shah.pending()).pending.some((p) => p.id === c.actionId));
  await rejects(shah.review(c.actionId, "rejected", ""), "note_required");
  assert.equal((await shah.review(c.actionId, "rejected", "Use Mucinex")).decision, "rejected");
  await rejects(shah.review(c.actionId, "approved", "changed my mind"), "not_found");
});

test("expired access token is refreshed automatically; the session survives", { skip }, async () => {
  const priya = new Client(base);
  await priya.login("priya", "priya-demo");
  await priya.openSession("pt-kamala");
  const oldRefresh = priya.creds.refresh_token;
  priya.creds.access_token = sign(
    { typ: "access", sub: "cg-priya", sid: priya.creds.session.id, pid: "pt-kamala" },
    process.env.JWT_ACCESS_SECRET,
    { expiresIn: 60, now: Date.now() - 3600e3 },
  );
  assert.equal((await get("/me", priya.creds.access_token)).body.error.code, "token_expired");
  const p = await priya.patient(); // triggers refresh + retry
  assert.equal(p.patient.name, "Kamala Iyer");
  assert.notEqual(priya.creds.refresh_token, oldRefresh); // rotated
});

test("refresh token reuse revokes the whole login; logout revokes too", { skip }, async () => {
  const a = await post("/auth/login", { username: "rao", password: "rao-demo" });
  const r1 = a.body.refresh_token;
  const b = await post("/auth/refresh", { refresh_token: r1 });
  assert.equal(b.status, 200);
  const r2 = b.body.refresh_token;
  assert.equal((await post("/auth/refresh", { refresh_token: r1 })).status, 401); // replay
  assert.match((await post("/auth/refresh", { refresh_token: r2 })).body.error.message, /already used/); // family revoked

  const c = await post("/auth/login", { username: "rao", password: "rao-demo" });
  assert.equal((await post("/auth/logout", { refresh_token: c.body.refresh_token })).status, 200);
  assert.equal((await post("/auth/refresh", { refresh_token: c.body.refresh_token })).status, 401);
  // a different login (family) is unaffected
  const d = await post("/auth/login", { username: "rao", password: "rao-demo" });
  assert.equal((await post("/auth/refresh", { refresh_token: d.body.refresh_token })).status, 200);
});

test("login: generic error, then throttled after 5 failures", { skip }, async () => {
  const bad = await post("/auth/login", { username: "nobody", password: "x" });
  assert.deepEqual(bad.body.error, { code: "invalid_credentials", message: "Invalid username or password." });
  for (let i = 0; i < 5; i++) await post("/auth/login", { username: "ortiz", password: "wrong" });
  const locked = await post("/auth/login", { username: "ortiz", password: "ortiz-demo" });
  assert.equal(locked.status, 429);
});

test("web UI: static files with CSP; refresh token only in an HttpOnly cookie, read only with X-Client: web", { skip }, async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");

  const web = { "content-type": "application/json", "x-client": "web" };
  const login = await fetch(`${base}/auth/login`, { method: "POST", headers: web, body: JSON.stringify({ username: "priya", password: "priya-demo" }) });
  const body = await login.json();
  assert.ok(body.access_token);
  assert.equal(body.refresh_token, undefined); // never visible to page scripts
  const setCookie = login.headers.get("set-cookie");
  assert.match(setCookie, /^msg_refresh=[^;]+; HttpOnly; SameSite=Strict; Path=\/auth; Max-Age=\d+/);
  const jar = setCookie.split(";")[0];

  // Cookie without the header (what a cross-site form post could send) is ignored.
  const csrf = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json", cookie: jar }, body: "{}" });
  assert.equal(csrf.status, 401);

  const r = await fetch(`${base}/auth/refresh`, { method: "POST", headers: { ...web, cookie: jar }, body: "{}" });
  assert.equal(r.status, 200);
  const rotated = r.headers.get("set-cookie").split(";")[0];
  assert.notEqual(rotated, jar);
  assert.equal((await r.json()).user.name, "Priya Iyer");

  const out = await fetch(`${base}/auth/logout`, { method: "POST", headers: { ...web, cookie: rotated }, body: "{}" });
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(`${base}/auth/refresh`, { method: "POST", headers: { ...web, cookie: rotated }, body: "{}" })).status, 401);
});
