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

test("invite flow: new caregiver has no patients until a care-team clinician invites them", { skip }, async () => {
  const kai = new Client(base);
  await kai.register("kai", "looks-after-ravi-26", "Kai Wong");
  assert.deepEqual((await kai.me()).patients, []);
  await rejects(kai.openSession("pt-ravi"), "forbidden");
  await rejects(kai.createInvite(), "no_session");

  const ortiz = new Client(base);
  await ortiz.login("ortiz", "ortiz-demo");
  const [first] = (await ortiz.me()).patients;
  assert.equal(first.id, "pt-kamala"); // Dr. Ortiz is not on Ravi's team
  await rejects(ortiz.openSession("pt-ravi"), "forbidden");

  const rao = new Client(base);
  await rao.login("rao", "rao-demo");
  await rao.openSession("pt-ravi");
  const inv = await rao.createInvite();
  assert.match(inv.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const priya = new Client(base);
  await priya.login("priya", "priya-demo");
  await priya.openSession("pt-kamala");
  await rejects(priya.createInvite(), "forbidden"); // caregivers can't invite

  await rejects(kai.acceptInvite("AAAA-BBBB"), "invalid_invite");
  assert.equal((await kai.acceptInvite(inv.code.toLowerCase())).patient.name, "Ravi Iyer");
  await rejects(kai.acceptInvite(inv.code), "invalid_invite"); // one use
  const s = await kai.openSession("pt-ravi");
  assert.equal(s.patient.name, "Ravi Iyer");
  assert.match((await kai.ask("Can he take Advil?")).answer, /Ravi Iyer \+ Advil.*CAUTION/);
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
