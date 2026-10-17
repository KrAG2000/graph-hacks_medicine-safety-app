/**
 * Interactive CLI: a client of the API (`npm start` runs it). Tokens are saved in
 * ~/.config/med-safety-graph/credentials.json (mode 600), so you stay logged in until the refresh token ends.
 * Account:   /register, /login, /logout, /whoami
 * Access:    /doctors, /request <n>, /requests   (ask a doctor for access; they approve)
 * Patient:   /patients, /switch [n]  (every question is about the chosen patient)
 * Ask:       free text, /meds, /check <drug>, /history [drug], /add <drug> [-- dose], /stop <drug>
 * Clinician: /requests, /accept <req-id> [patient n] [-- note], /decline <req-id> -- <reason>,
 *            /pending, /approve <act-id> [-- note], /reject <act-id> -- <reason>
 */
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { Client, fileStore } from "./client.js";

const client = new Client(process.env.MSG_API_URL, fileStore());

const rl = readline.createInterface({ input, output, terminal: input.isTTY });
let muted = false;
rl._writeToOutput = (s) => output.write(muted && !/[\r\n]/.test(s) ? "*".repeat(s.length) : s);
const lines = rl[Symbol.asyncIterator]();
async function prompt(q, { secret = false } = {}) {
  output.write(q);
  muted = secret;
  const { value, done } = await lines.next();
  muted = false;
  if (done) return null;
  if (!input.isTTY) output.write(secret ? "********\n" : `${value}\n`);
  return value.trim();
}
const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));
const user = () => client.creds?.user;
let doctors = [];
let lastPatients = [];
const session = () => client.creds?.session;

async function doLogin() {
  const username = await prompt("Username: ");
  const password = username === null ? null : await prompt("Password: ", { secret: true });
  if (password === null) return;
  const u = await client.login(username, password);
  console.log(`Welcome, ${u.name} (${u.role}).`);
  await choosePatient();
}

async function doRegister() {
  console.log("New account. (Clinician accounts are created by an administrator.)");
  const who = await prompt("Are you the patient, or looking after someone? [patient/caregiver]: ");
  if (who === null) return;
  const role = /^p/i.test(who) ? "patient" : "caregiver";
  const age = role === "patient" ? await prompt("Your age: ") : undefined;
  if (age === null) return;
  const username = await prompt("Choose a username: ");
  const name = username === null ? null : await prompt("Your full name: ");
  const password = name === null ? null : await prompt("Password (10+ characters): ", { secret: true });
  const again = password === null ? null : await prompt("Repeat password: ", { secret: true });
  if (again === null) return;
  if (password !== again) return console.log("Passwords don't match.");
  const u = await client.register(username, password, name, { role, age });
  console.log(`Account created. Welcome, ${u.name}.`);
  await choosePatient();
}

async function choosePatient(pick = "") {
  const { patients } = await client.me();
  if (!patients.length) {
    console.log(
      user().kind === "Clinician"
        ? "You have no patients yet. Patients and caregivers can request you; see /requests."
        : "You are not on any care team yet. See /doctors, then /request <n> to ask a doctor. You'll get access when they approve.",
    );
    return;
  }
  let chosen = patients.length === 1 ? patients[0] : null;
  while (!chosen) {
    patients.forEach((p, i) => console.log(`  ${i + 1}. ${p.name} (${p.age})`));
    const a = pick || (await prompt("Choose a patient (number): "));
    pick = "";
    if (a === null) return;
    chosen = patients[Number(a) - 1] || patients.find((p) => p.name.toLowerCase().startsWith(a.toLowerCase()));
    if (!chosen) console.log("Not one of your patients.");
  }
  const s = await client.openSession(chosen.id);
  const first = s.patient.name.split(" ")[0];
  console.log(`Session ${s.id}: everything you ask now is about ${s.patient.name}.`);
  console.log(`Try: "What is ${first} taking?" | "Can ${first} take Advil?" | "Is NyQuil okay?" | "What did we decide about Biaxin?"`);
  console.log(
    "Commands: /meds, /check <drug>, /add <drug> [-- dose], /stop <drug>, /history [drug], /patients, /switch [n], /doctors, /requests, /whoami, /logout, quit" +
      (user().kind === "Clinician" ? "\nClinician: /requests, /accept <req-id> [patient n] [-- note], /decline <req-id> -- <reason>, /pending, /approve <act-id> [-- note], /reject <act-id> -- <reason>" : ""),
  );
}

async function review(rest, decision) {
  const [head, note = ""] = rest.split(/\s+--\s+/);
  const id = head.trim().split(/\s+/)[0];
  if (!id) return `Usage: /${decision === "approved" ? "approve" : "reject"} <act-id> -- <note>`;
  const r = await client.review(id, decision, note.trim());
  return `${r.decision} ${r.id} for ${r.patient}`;
}

const formatHistory = (h) =>
  h.length
    ? h
        .filter((x) => x.kind === "check")
        .map((x) => `${(x.ts || "").slice(0, 10)} ${x.drug}: ${String(x.level).toUpperCase()} → ${x.status}` +
          (x.reviewer ? ` by ${x.reviewer}: "${x.note}"` : "") + (x.asked_by ? ` (asked by ${x.asked_by})` : ""))
        .join("\n") || "No checks yet."
    : "No checks yet.";

// ---- start ----
await client.init();
console.log("Medication Safety Graph. A decision aid on illustrative data, not medical advice.");
if (user()) {
  try {
    const me = await client.me();
    console.log(`Welcome back, ${me.user.name}.` + (me.session ? ` Continuing with ${me.session.patient.name}.` : ""));
    if (!me.session) await choosePatient();
  } catch (e) {
    console.log(e.message);
  }
}
if (!user()) console.log("Type /login or /register.");

while (true) {
  const where = !user() ? "" : session() ? `${user().name} → ${session().patient.name}` : user().name;
  const q = await prompt(`\n${where}> `);
  if (q === null || q === "quit" || q === "exit") break;
  if (!q) continue;
  const [cmd, ...restWords] = q.split(/\s+/);
  const rest = restWords.join(" ");
  try {
    if (cmd === "/login") await doLogin();
    else if (cmd === "/register") await doRegister();
    else if (!user()) console.log("Please /login or /register first.");
    else if (cmd === "/logout") {
      await client.logout();
      console.log("Logged out. Your refresh token was revoked on the server.");
    } else if (cmd === "/whoami") {
      const me = await client.me();
      print(`${me.user.name} (${me.user.role})` + (me.session ? `, session ${me.session.id} about ${me.session.patient.name}` : ", no patient selected"));
    } else if (cmd === "/patients") {
      const { patients } = await client.me();
      print(patients.map((p, i) => `${i + 1}. ${p.name} (${p.age})`).join("\n") || "No patients yet. See /doctors and /request.");
    } else if (cmd === "/switch") await choosePatient(rest);
    else if (cmd === "/doctors") {
      doctors = (await client.clinicians()).clinicians;
      print(doctors.map((c, i) => `${i + 1}. ${c.name} (${c.role}), ${c.patients} patient(s)`).join("\n"));
    } else if (cmd === "/request") {
      if (!doctors.length) doctors = (await client.clinicians()).clinicians;
      const doc = doctors[Number(rest) - 1];
      if (!doc) print("Usage: /request <n> (see /doctors)");
      else {
        let patient_name, relation;
        if (user().kind === "Caregiver") {
          patient_name = await prompt("Full name of the person you look after: ");
          relation = await prompt("Your relationship to them (e.g. daughter): ");
        }
        const message = await prompt(`Message for ${doc.name} (optional): `);
        const { request } = await client.requestAccess(doc.id, { patient_name, relation, message });
        print(`Request ${request.id} sent to ${request.clinician}. You'll get access when they approve (see /requests).`);
      }
    } else if (cmd === "/requests") {
      const r = await client.requests();
      if (r.inbox) {
        lastPatients = r.patients;
        print(
          (r.inbox.map((q) => `${q.id}  ${q.from_name} (${q.from_kind}${q.from_age ? `, ${q.from_age}` : ""})` +
            (q.kind === "self" ? " asks you to join their care team" : ` looks after "${q.patient_name}"${q.relation ? ` (${q.relation})` : ""}`) +
            (q.message ? `\n      "${q.message}"` : "")).join("\n") || "No pending requests.") +
            (r.inbox.some((q) => q.kind === "caregiver") ? `\nYour patients: ${r.patients.map((p, i) => `${i + 1}. ${p.name}`).join("  ")}` : ""),
        );
      } else
        print(r.mine.map((q) => `${q.id}  to ${q.clinician}: ${q.status}${q.patient ? ` (${q.patient})` : ""}${q.note ? ` · "${q.note}"` : ""}`).join("\n") || "No requests sent.");
    } else if (cmd === "/accept" || cmd === "/decline") {
      const [head, note = ""] = rest.split(/\s+--\s+/);
      const [id, n] = head.trim().split(/\s+/);
      const r = await client.decideRequest(id, cmd === "/accept" ? "approved" : "rejected", { patient_id: lastPatients[Number(n) - 1]?.id, note });
      print(r.status === "approved" ? `Approved: ${r.patient}.` : "Declined.");
    } else if (!session()) console.log("Pick a patient first: /switch (or /doctors and /request if you have none).");
    else if (cmd === "/add") {
      const [drug, dose = ""] = rest.split(/\s+--\s+/);
      const r = await client.addMedication(drug.trim(), dose.trim());
      print(`Added ${r.drug} (${r.dose})${r.prescribed ? " as a prescription" : " as over-the-counter"}. Tip: /check ${r.drug}`);
    } else if (cmd === "/stop") {
      print(`Stopped ${(await client.stopMedication(rest)).drug}.`);
    } else if (cmd === "/meds") {
      const p = await client.patient();
      print(p.medications.map((m) => `${m.brand} (${m.drug}) ${m.dose}` + (m.prescriber ? `, prescribed by ${m.prescriber}` : ", over the counter")).join("\n"));
    } else if (cmd === "/check") {
      const c = await client.check(rest);
      print(`${c.explanation || c.summary}\n\n(recorded as ${c.actionId}, pending clinician review)`);
    } else if (cmd === "/history") print(formatHistory((await client.history(rest)).history));
    else if (cmd === "/pending") {
      const { pending } = await client.pending();
      print(pending.map((p) => `${p.id}  ${p.drug}  ${String(p.level).toUpperCase()}  asked by ${p.asked_by}`).join("\n") || "Nothing pending.");
    } else if (cmd === "/approve") print(await review(rest, "approved"));
    else if (cmd === "/reject") print(await review(rest, "rejected"));
    else if (cmd.startsWith("/")) print(`Unknown command ${cmd}`);
    else {
      const { answer, trace } = await client.ask(q);
      for (const t of trace) console.log(t);
      console.log("\nAssistant>", answer);
    }
  } catch (e) {
    console.error(`Error: ${e.message}`);
  }
}
rl.close();
