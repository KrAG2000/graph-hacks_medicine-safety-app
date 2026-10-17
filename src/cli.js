/**
 * Interactive CLI: a client of the API (`npm start` runs it). Tokens are saved in
 * ~/.config/med-safety-graph/credentials.json (mode 600), so you stay logged in until the refresh token ends.
 * Account:   /register, /login, /logout, /whoami, /join <invite-code>
 * Patient:   /patients, /switch [n]  (every question is about the chosen patient)
 * Ask:       free text, /meds, /check <drug>, /history [drug]
 * Clinician: /pending, /approve <act-id> [-- note], /reject <act-id> -- <reason>, /invite
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
  console.log("New caregiver account. (Clinician accounts are created by an administrator.)");
  const username = await prompt("Choose a username: ");
  const name = username === null ? null : await prompt("Your full name: ");
  const password = name === null ? null : await prompt("Password (10+ characters): ", { secret: true });
  const again = password === null ? null : await prompt("Repeat password: ", { secret: true });
  if (again === null) return;
  if (password !== again) return console.log("Passwords don't match.");
  const u = await client.register(username, password, name);
  console.log(`Account created. Welcome, ${u.name}.`);
  await choosePatient();
}

async function choosePatient(pick = "") {
  const { patients } = await client.me();
  if (!patients.length) {
    console.log(
      "You are not on any patient's care team yet. Ask a clinician on the care team for an invite code, then type /join <code>.",
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
    "Commands: /meds, /check <drug>, /history [drug], /patients, /switch [n], /join <code>, /whoami, /logout, quit" +
      (user().kind === "Clinician" ? "\nClinician: /pending, /approve <act-id> [-- note], /reject <act-id> -- <reason>, /invite" : ""),
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
      print(patients.map((p, i) => `${i + 1}. ${p.name} (${p.age})`).join("\n") || "No patients yet. Use /join <code>.");
    } else if (cmd === "/switch") await choosePatient(rest);
    else if (cmd === "/join") {
      const { patient } = await client.acceptInvite(rest);
      console.log(`You joined ${patient.name}'s care team.`);
      await choosePatient();
    } else if (!session()) console.log("Pick a patient first: /switch (or /join <code> if you have none).");
    else if (cmd === "/invite") {
      const inv = await client.createInvite();
      print(`Invite code for ${inv.patient}: ${inv.code} (one use, expires ${inv.expires.slice(0, 10)}). Give it to the caregiver.`);
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
