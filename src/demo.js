/**
 * Scripted demo (good for a video). Starts the API in-process and drives it with API clients, like the CLI does:
 * patient and caregiver registration, access requests approved by doctors, JWT login, patient-scoped sessions, checker handoff, pharmacist decision,
 * refresh-token rotation and reuse detection, and memory across sessions.
 */
import { connect } from "./db.js";
import { createLLM } from "./llm.js";
import { startServer } from "./server.js";
import { Client } from "./client.js";

let db, graph;
try {
  ({ db, graph } = await connect());
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
const llm = createLLM();
const server = await startServer({ graph, llm, port: 0 });
const base = `http://127.0.0.1:${server.address().port}`;
const client = () => new Client(base);
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
const tryIt = async (label, fn) => {
  try {
    await fn();
    console.log(`${label} -> allowed`);
  } catch (e) {
    console.log(`${label} -> refused (${e.status} ${e.code})`);
  }
};
const registerOrLogin = async (c, username, password, name, opts) => {
  try {
    await c.register(username, password, name, opts);
    console.log(`registered ${username} (${opts.role})`);
  } catch (e) {
    if (e.code !== "username_taken") throw e;
    await c.login(username, password);
    console.log(`${username} already registered; logged in`);
  }
};
const say = async (c, q) => {
  console.log(`\n${c.creds.user.name} → ${c.creds.session.patient.name}> ${q}`);
  const { answer, trace } = await c.ask(q);
  trace.forEach((t) => console.log("   " + t));
  console.log(answer);
};

console.log(`API ${base}, LLM provider: ${llm.name}`);

console.log("\n=== 1. A new patient registers and asks a doctor to join her care team ===");
const lena = client();
await registerOrLogin(lena, "lena", "knees-and-tea-26", "Lena Fischer", { role: "patient", age: 72 });
console.log(`lena's own record: ${JSON.stringify((await lena.me()).patients.map((p) => p.name))}`);
const { clinicians } = await lena.clinicians();
console.log(`doctor directory: ${clinicians.length} clinicians, e.g. ${clinicians.slice(0, 6).map((c) => `${c.name} (${c.role}, ${c.patients} patients)`).join("; ")} …`);
const menonId = clinicians.find((c) => c.name.includes("Menon")).id;
await tryIt("lena asks Dr. Menon", () => lena.requestAccess(menonId, { message: "My knees hurt and I take a lot of tablets." }));
await tryIt("lena asks Dr. Menon again while pending", () => lena.requestAccess(menonId));

const menon = client();
await menon.login("menon", "menon-demo");
const { inbox: menonInbox } = await menon.requests();
console.log(`Dr. Menon's inbox: ${menonInbox.map((q) => `${q.from_name} (${q.from_kind}, ${q.from_age}): ${q.kind}`).join("; ")}`);
const approved = await menon.decideRequest(menonInbox[0].id, "approved", { note: "Welcome, see you Tuesday." });
console.log(`approved -> Dr. Menon now cares for ${approved.patient}`);
await menon.openSession(approved.patient_id);
await menon.addCondition("cond-ulcer");
await menon.addMedication("Tylenol", "500 mg up to 3 times a day");
console.log("Dr. Menon records a stomach ulcer and prescribes Tylenol");
await lena.openSession(lena.creds.user.id);
await say(lena, "Can I take Advil for my knees?");

console.log("\n=== 2. A caregiver asks Dr. Rao for access to someone she looks after ===");
const neha = client();
await registerOrLogin(neha, "neha", "kamala-helper-26", "Neha Kapoor", { role: "caregiver" });
console.log(`neha can see: ${JSON.stringify((await neha.me()).patients.map((p) => p.name))}`);
await tryIt("neha opens Kamala's record before approval", () => neha.openSession("pt-kamala"));
const raoId = clinicians.find((c) => c.name.includes("Rao")).id;
await neha.requestAccess(raoId, { patient_name: "Kamala Iyer", relation: "neighbour", message: "I help Kamala with her medicines on weekdays." });
const rao = client();
await rao.login("rao", "rao-demo");
const { inbox: raoInbox, patients: raoPatients } = await rao.requests();
const req = raoInbox.find((q) => q.from_name === "Neha Kapoor");
console.log(`Dr. Rao sees: ${req.from_name} looks after "${req.patient_name}" (${req.relation}); Dr. Rao's patients: ${raoPatients.map((p) => p.name).join(", ")}`);
await rao.decideRequest(req.id, "approved", { patient_id: "pt-kamala", note: "Thanks for helping her." });
await neha.openSession("pt-kamala");
await say(neha, "What is she taking?");

console.log("\n=== 3. Priya logs in (JWT access + refresh) and asks about her mother ===");
const priya = client();
await priya.login("priya", "priya-demo");
const t = claims(priya.creds.access_token);
console.log(`access token: typ=${t.typ} sub=${t.sub} expires in ${t.exp - t.iat}s, patient=${t.pid}`);
await priya.openSession("pt-kamala");
console.log(`after picking a patient: patient=${claims(priya.creds.access_token).pid} session=${claims(priya.creds.access_token).sid}`);
await say(priya, "She has a bad headache. Can she take Advil?");
await say(priya, "She also has a cold. Is NyQuil okay?");

console.log("\n=== 4. Scoping: Sam cares only for his father ===");
const sam = client();
await sam.login("sam", "sam-demo");
await tryIt("sam opens Kamala's record", () => sam.openSession("pt-kamala"));

console.log("\n=== 5. Pharmacist Arjun Shah reviews Kamala's pending checks ===");
const shah = client();
await shah.login("shah", "shah-demo");
await shah.openSession("pt-kamala");
const { pending } = await shah.pending();
pending.forEach((p) => console.log(`  ${p.id} ${p.drug} ${p.level} (asked by ${p.asked_by})`));
const nyquil = pending.find((p) => p.drug === "NyQuil");
const note = "Do not use NyQuil: doubles up on acetaminophen with her Tylenol. Use Mucinex for the cold.";
await shah.review(nyquil.id, "rejected", note);
console.log(`  rejected ${nyquil.id}: "${note}"`);
await tryIt("Priya (a caregiver) approves it anyway", () => priya.review(nyquil.id, "approved"));

console.log("\n=== 6. Refresh-token rotation and reuse detection ===");
const old = priya.creds.refresh_token;
await priya.refresh();
console.log(`refreshed: new refresh token issued (${priya.creds.refresh_token !== old}), session kept (${priya.creds.session?.patient.name})`);
const replay = await fetch(`${base}/auth/refresh`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ refresh_token: old }),
});
console.log(`attacker replays the OLD refresh token -> ${replay.status} ${(await replay.json()).error.message}`);
await tryIt("Priya's current refresh token after the replay (whole login revoked)", () => priya.refresh());

console.log("\n=== 7. Priya logs in again next day: memory from the graph ===");
await priya.login("priya", "priya-demo");
await priya.openSession("pt-kamala");
await say(priya, "What did we decide about NyQuil?");
await say(priya, "Her doctor mentioned Biaxin for an infection. Can she take it?");

await priya.logout();
await new Promise((r) => server.close(r));
await db.close();
