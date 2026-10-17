/**
 * MedSafe Graph web UI. No framework, no build step.
 * Auth: the access token lives only in memory; the refresh token is an HttpOnly cookie the page can't read.
 * Every request sends `X-Client: web`. All user and graph text goes into the DOM via textContent.
 */

// ---------------------------------------------------------------- state
const state = {
  token: null,
  user: null,
  session: null,
  patients: [],
  patient: null, // {patient, medications, conditions, allergies, care_team}
  catalog: null, // {drugs, conditions, allergens}
  tab: "check",
  view: "main", // "main" | "requests"
  requests: null, // {mine} for patients/caregivers, {inbox, patients} for clinicians
  clinicians: null,
  reqDoctor: null,
  editing: null, // "med" | "allergy" | "condition"
  pendingAdd: null, // {drug, dose}: checked first, added only when the user confirms after seeing the result
  regRole: "caregiver",
  check: null,
  checking: false,
  chat: [],
  asking: false,
  history: null,
  pending: null,
  menu: false,
  authTab: "login",
  authError: "",
  busy: false,
  booted: false,
};

const store = {
  get: (k) => {
    try {
      return localStorage.getItem(`msg.${k}`);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      if (v) localStorage.setItem(`msg.${k}`, v);
      else localStorage.removeItem(`msg.${k}`);
    } catch {
      /* private mode: the session just won't be restored */
    }
  },
};

// ---------------------------------------------------------------- DOM helpers
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ICONS = {
  pill: ["M10.5 20.5 20.5 10.5a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z", "m8.5 8.5 7 7"],
  shield: ["M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"],
  stop: ["M7.86 2h8.28L22 7.86v8.28L16.14 22H7.86L2 16.14V7.86L7.86 2z", "M15 9l-6 6", "M9 9l6 6"],
  alert: ["M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z", "M12 9v4", "M12 17h.01"],
  eye: ["M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  check: ["M20 6 9 17l-5-5"],
  search: ["M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z", "m21 21-4.35-4.35"],
  chat: ["M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "M12 6v6l4 2"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"],
  logout: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "m16 17 5-5-5-5", "M21 12H9"],
  chevron: ["m6 9 6 6 6-6"],
  send: ["m22 2-7 20-4-9-9-4z", "M22 2 11 13"],
  key: ["M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4"],
  copy: ["M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z", "M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"],
  phone: ["M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"],
  memory: ["M3 12a9 9 0 1 0 3-6.7L3 8", "M3 3v5h5", "M12 7v5l3 2"],
  graph: ["M5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M19 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M12 22a2 2 0 1 0 0-4 2 2 0 0 0 0 4z", "M6.5 5.5 17.5 6", "M5.8 5.8 11 18.5", "M18.3 7.7 13 18.5"],
  plus: ["M12 5v14", "M5 12h14"],
  users: ["M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M23 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
};
function icon(name, size = 18) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" }))
    svg.setAttribute(k, v);
  for (const d of ICONS[name] || []) {
    const p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.append(p);
  }
  return svg;
}

const initials = (name = "") => name.replace(/^Dr\.\s*/, "").split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
const firstName = (name = "") => name.split(" ")[0];
const day = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "");

function toast(text, kind = "") {
  const t = h("div", { class: `toast ${kind}`, text });
  const box = document.getElementById("toasts");
  box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => t.remove(), 4200);
}

/** Tiny, safe markdown for assistant replies: paragraphs, bullet lists, **bold**. */
function md(text) {
  const out = [];
  let list = null;
  const inline = (line) => line.split(/(\*\*[^*]+\*\*)/g).map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? h("strong", { text: part.slice(2, -2) }) : part));
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) out.push((list = h("ul")));
      list.append(h("li", {}, inline(bullet[1])));
    } else {
      list = null;
      if (line.trim()) out.push(h("p", {}, inline(line.replace(/^#+\s*/, ""))));
    }
  }
  return out;
}

// ---------------------------------------------------------------- API
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

async function raw(method, path, body, token = state.token) {
  let res;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: { "content-type": "application/json", "x-client": "web", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline", "Can't reach the server.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error?.code || "error", data.error?.message || res.statusText);
  return data;
}

let refreshing = null;
let refreshTimer = null;
function refresh() {
  refreshing ||= (async () => {
    const r = await raw("POST", "/auth/refresh", { session_id: store.get("sid") }, null);
    applyTokens(r);
    if ("session" in r) setSession(r.session);
    return r;
  })().finally(() => (refreshing = null));
  return refreshing;
}

function applyTokens(r) {
  state.token = r.access_token;
  if (r.user) state.user = r.user;
  clearTimeout(refreshTimer);
  // Renew a minute before the access token expires, so long-open pages keep working.
  const ms = Math.max(30, (r.expires_in || 900) - 60) * 1000;
  refreshTimer = setTimeout(() => refresh().catch(() => signedOut("Your sign-in ended. Please sign in again.")), ms);
}

function setSession(s) {
  state.session = s || null;
  store.set("sid", s?.id || "");
}

async function api(method, path, body) {
  try {
    return await raw(method, path, body);
  } catch (e) {
    if (e.code === "token_expired") {
      try {
        await refresh();
      } catch {
        signedOut("Your sign-in ended. Please sign in again.");
        throw e;
      }
      return raw(method, path, body);
    }
    if (e.code === "access_revoked") {
      setSession(null);
      state.patient = null;
      toast("You no longer have access to that patient.", "error");
      await loadMe().catch(() => {});
      render();
    } else if (e.status === 401) signedOut("Please sign in again.");
    throw e;
  }
}

function signedOut(message) {
  clearTimeout(refreshTimer);
  document.getElementById("toasts").replaceChildren(); // don't show one account's messages to the next
  Object.assign(state, { token: null, user: null, session: null, patients: [], patient: null, check: null, chat: [], history: null, pending: null, menu: false, view: "main", requests: null, clinicians: null, reqDoctor: null, editing: null, authTab: "login", authError: "" });
  store.set("sid", "");
  if (message) toast(message);
  render();
}

// ---------------------------------------------------------------- flows
async function loadMe() {
  const me = await api("GET", "/me");
  state.user = me.user;
  state.patients = me.patients;
  if (me.session) setSession(me.session);
  return me;
}

async function afterSignIn() {
  const me = await loadMe();
  await Promise.all([loadRequests(), me.patients.length || me.user.kind === "Clinician" ? null : loadClinicians()]).catch(() => {});
  if (me.session) await loadPatient();
  else if (me.patients.length === 1) await openSession(me.patients[0].id);
  render();
}

async function openSession(patientId) {
  const r = await api("POST", "/sessions", { patient_id: patientId });
  state.token = r.access_token; // pinned to this patient
  setSession(r.session);
  Object.assign(state, { check: null, chat: [], history: null, pending: null, menu: false, view: "main", editing: null, pendingAdd: null, tab: "check" });
  await loadPatient();
  render();
}

async function loadPatient() {
  const clinician = state.user?.kind === "Clinician";
  const [p, c] = await Promise.all([api("GET", "/patient"), state.catalog ? null : api("GET", "/catalog")]);
  state.patient = p;
  if (c) state.catalog = c;
  await Promise.all([loadHistory(), clinician ? loadPending() : null]);
}
const loadRequests = async () => (state.requests = await api("GET", "/requests"));
const loadClinicians = async () => (state.clinicians = (await api("GET", "/clinicians")).clinicians);
const loadHistory = async () => (state.history = (await api("GET", "/history")).history);
const loadPending = async () => (state.pending = (await api("GET", "/pending")).pending);

async function signIn(path, payload) {
  state.busy = true;
  state.authError = "";
  render();
  try {
    applyTokens(await raw("POST", path, payload, null));
    setSession(null);
    await afterSignIn();
  } catch (e) {
    state.authError = e.message;
  } finally {
    state.busy = false;
    render();
  }
}

async function signOut() {
  await raw("POST", "/auth/logout", {}, null).catch(() => {});
  signedOut("Signed out.");
}

async function runCheck(drug) {
  drug = drug.trim();
  if (!drug || state.checking) return;
  state.checking = true;
  state.check = null;
  state.tab = "check";
  render();
  try {
    state.check = await api("POST", "/check", { drug });
    await Promise.all([loadHistory(), state.user.kind === "Clinician" ? loadPending() : null]);
  } catch (e) {
    state.check = { error: e.message, drug };
  } finally {
    state.checking = false;
    render();
  }
}

async function sendQuestion(q) {
  q = q.trim();
  if (!q || state.asking) return;
  state.chat.push({ role: "user", text: q });
  state.asking = true;
  render();
  try {
    const r = await api("POST", "/ask", { question: q });
    state.chat.push({ role: "bot", text: r.answer, trace: r.trace });
    if (r.trace.some((t) => t.includes("[checker]"))) await Promise.all([loadHistory(), state.user.kind === "Clinician" ? loadPending() : null]);
  } catch (e) {
    state.chat.push({ role: "bot", text: `Sorry, that didn't work: ${e.message}` });
  } finally {
    state.asking = false;
    render();
    document.querySelector(".chat-form textarea")?.focus();
  }
}

async function decide(id, decision, note) {
  try {
    await api("POST", "/reviews", { action_id: id, decision, note });
    toast(decision === "approved" ? "Approved and recorded in the graph." : "Rejected and recorded in the graph.");
    await Promise.all([loadPending(), loadHistory()]);
  } catch (e) {
    toast(e.message, "error");
  }
  render();
}

async function showRequests() {
  state.view = "requests";
  state.menu = false;
  render();
  try {
    await Promise.all([loadRequests(), loadMe(), state.user.kind === "Clinician" ? null : loadClinicians()]);
  } catch (e) {
    toast(e.message, "error");
  }
  render();
}

async function sendRequest(form) {
  const f = new FormData(form);
  try {
    const { request } = await api("POST", "/requests", {
      clinician_id: state.reqDoctor,
      patient_name: f.get("patient_name") || undefined,
      relation: f.get("relation") || undefined,
      message: f.get("message") || "",
    });
    toast(`Request sent to ${request.clinician}. You'll get access when they approve.`);
    state.reqDoctor = null;
    await loadRequests();
  } catch (e) {
    toast(e.message, "error");
  }
  render();
}

async function decideAccess(req, decision, patientId, note) {
  try {
    const r = await api("POST", "/requests/decide", { request_id: req.id, decision, patient_id: patientId, note });
    toast(r.status !== "approved" ? "Request declined." : req.kind === "self" ? `${r.patient} is now your patient.` : `Approved. ${req.from_name} now has access to ${r.patient}.`);
    await Promise.all([loadRequests(), loadMe()]);
  } catch (e) {
    toast(e.message, "error");
  }
  render();
}

async function editRecord(path, payload, done) {
  try {
    const r = await api("POST", path, payload);
    state.editing = null;
    state.patient = await api("GET", "/patient");
    toast(done(r));
    return r;
  } catch (e) {
    toast(e.message, "error");
    render();
    return null;
  }
}

// ---------------------------------------------------------------- views
const LEVELS = {
  stop: { label: "STOP", title: "Don't start this yet", advice: "Do not start this until a clinician confirms it is safe.", icon: "stop" },
  caution: { label: "CAUTION", title: "Check with the care team first", advice: "Check with the pharmacist or prescriber before starting.", icon: "alert" },
  monitor: { label: "OK WITH MONITORING", title: "Probably fine, with monitoring", advice: "Tell the care team and watch for the effects listed.", icon: "eye" },
  no_known_issues: { label: "NO CONFLICTS FOUND", title: "No conflicts in the graph", advice: "This graph is not a complete drug database, so still confirm with a pharmacist.", icon: "check" },
};

function authView() {
  const login = state.authTab === "login";
  const fill = (u) => {
    document.getElementById("username").value = u;
    document.getElementById("password").value = `${u}-demo`;
  };
  const demos = [
    ["Family", [["priya", "Priya Iyer", "Caregiver · Kamala, Ravi"], ["sam", "Sam Iyer", "Caregiver · Ravi"]]],
    ["Care team", [["rao", "Dr. Meera Rao", "Primary care · 2 patients"], ["ortiz", "Dr. Lena Ortiz", "Cardiologist · Kamala"], ["shah", "Arjun Shah", "Pharmacist · 2 patients"]]],
    ["Doctors with no patients yet (22 more specialists in the directory)", [["menon", "Dr. Kavita Menon", "Geriatrician"], ["okafor", "Dr. Samuel Okafor", "Endocrinologist"]]],
  ];
  const onSubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (login) return signIn("/auth/login", { username: f.get("username"), password: f.get("password") });
    if (f.get("password") !== f.get("password2")) {
      state.authError = "Passwords don't match.";
      return render();
    }
    signIn("/auth/register", { role: state.regRole, age: f.get("age") || undefined, username: f.get("username"), name: f.get("name"), password: f.get("password") });
  };
  return h("div", { class: "auth" },
    h("section", { class: "auth-brand" },
      h("div", {},
        h("div", { class: "brand" }, h("div", { class: "brand-mark" }, icon("pill", 18)), h("span", { text: "MedSafe Graph" })),
        h("h1", { text: "Know if a new medicine is safe before it's taken." }),
        h("p", { text: "For families looking after someone on several medicines. Every answer shows the chain of facts behind it and who to call." }),
        h("ul", { class: "auth-points" },
          h("li", {}, icon("graph"), h("span", { text: "Finds hidden conflicts across ingredients, drug classes, conditions, allergies and age." })),
          h("li", {}, icon("phone"), h("span", { text: "Tells you who to contact: the doctor who prescribed the conflicting medicine, then the pharmacist." })),
          h("li", {}, icon("shield"), h("span", { text: "Never decides alone: every check waits for a clinician on the care team." })),
        ),
      ),
      h("p", { class: "auth-foot", text: "Built on a FalkorDB knowledge graph. Demo data only, not medical advice." }),
    ),
    h("section", { class: "auth-panel" },
      h("div", { class: "auth-card" },
        h("h2", { text: login ? "Welcome back" : state.regRole === "patient" ? "Create your patient account" : "Create a caregiver account" }),
        h("p", { class: "muted", text: login ? "Sign in to continue." : "After signing up you'll ask a doctor for access. You can use the app once they approve." }),
        h("div", { class: "auth-tabs", role: "tablist" },
          h("button", { role: "tab", "aria-selected": String(login), onclick: () => ((state.authTab = "login"), (state.authError = ""), render()), text: "Sign in" }),
          h("button", { role: "tab", "aria-selected": String(!login), onclick: () => ((state.authTab = "register"), (state.authError = ""), render()), text: "Create account" }),
        ),
        state.authError && h("div", { class: "form-error", role: "alert", text: state.authError }),
        h("form", { onsubmit: onSubmit },
          !login && h("div", { class: "field" },
            h("label", { text: "I am" }),
            h("div", { class: "auth-tabs role-tabs", role: "radiogroup" },
              h("button", { type: "button", role: "radio", "aria-selected": String(state.regRole === "patient"), "aria-checked": String(state.regRole === "patient"), onclick: () => ((state.regRole = "patient"), render()), text: "The patient" }),
              h("button", { type: "button", role: "radio", "aria-selected": String(state.regRole === "caregiver"), "aria-checked": String(state.regRole === "caregiver"), onclick: () => ((state.regRole = "caregiver"), render()), text: "Looking after someone" }),
            ),
          ),
          !login && h("div", { class: "field" }, h("label", { for: "name", text: "Full name" }), h("input", { class: "input", id: "name", name: "name", required: true, autocomplete: "name", maxlength: 80 })),
          !login && state.regRole === "patient" && h("div", { class: "field" },
            h("label", { for: "age", text: "Age" }),
            h("input", { class: "input", id: "age", name: "age", type: "number", min: 0, max: 120, required: true }),
            h("span", { class: "hint", text: "Some medicines need extra care at older ages." }),
          ),
          h("div", { class: "field" }, h("label", { for: "username", text: "Username" }), h("input", { class: "input", id: "username", name: "username", required: true, autocomplete: "username", autocapitalize: "none", spellcheck: "false" })),
          h("div", { class: "field" },
            h("label", { for: "password", text: "Password" }),
            h("input", { class: "input", id: "password", name: "password", type: "password", required: true, autocomplete: login ? "current-password" : "new-password", minlength: login ? null : 10 }),
            !login && h("span", { class: "hint", text: "At least 10 characters, not containing your username." }),
          ),
          !login && h("div", { class: "field" }, h("label", { for: "password2", text: "Repeat password" }), h("input", { class: "input", id: "password2", name: "password2", type: "password", required: true, autocomplete: "new-password" })),
          h("button", { class: "btn primary block", type: "submit", disabled: state.busy }, state.busy ? h("span", { class: "spinner" }) : null, login ? "Sign in" : "Create account"),
        ),
        login && h("div", { class: "demo-box" },
          h("h4", { text: "Demo accounts" }),
          demos.map(([group, list]) => [
            h("div", { class: "demo-group", text: group }),
            h("div", { class: "demo-list" }, list.map(([u, n, r]) => h("button", { type: "button", onclick: () => fill(u) }, h("strong", { text: n }), h("span", { text: r })))),
          ]),
          h("p", { class: "hint", text: "Password for every demo account: <username>-demo" }),
        ),
      ),
    ),
  );
}

function topbar() {
  const s = state.session;
  return h("header", { class: "topbar" },
    h("div", { class: "brand" }, h("div", { class: "brand-mark" }, icon("pill", 16)), h("span", { class: "name", text: "MedSafe Graph" })),
    (s || state.patients.length > 0) && h("div", { class: "switcher" },
      h("button", { class: "switcher-btn", "aria-haspopup": "true", "aria-expanded": String(state.menu), onclick: () => ((state.menu = !state.menu), render()) },
        h("span", { class: "avatar sm", text: s ? initials(s.patient.name) : "?" }),
        h("span", { text: s ? s.patient.name : "Choose patient" }),
        icon("chevron", 16),
      ),
      state.menu && h("div", { class: "menu", role: "menu" },
        state.patients.map((p) => h("button", { role: "menuitem", onclick: () => openSession(p.id).catch((e) => toast(e.message, "error")) },
          h("span", { class: "avatar sm", text: initials(p.name) }),
          h("span", {}, h("strong", { text: p.name }), " ", h("span", { class: "faint", text: `${p.age}` })),
          s?.patient.id === p.id && h("span", { class: "faint" }, icon("check", 14)),
        )),
        state.user.kind !== "Clinician" && [h("hr"), h("button", { role: "menuitem", onclick: showRequests }, icon("plus", 16), state.user.kind === "Patient" ? "Add a doctor to my care team" : "Get access to someone else")],
      ),
    ),
    h("div", { class: "spacer" }),
    h("button", { class: `btn ghost small ${state.view === "requests" ? "active" : ""}`, onclick: () => (state.view === "requests" ? ((state.view = "main"), render()) : showRequests()) },
      icon("users", 16), h("span", { class: "name", text: state.user.kind === "Clinician" ? "Requests" : "Doctors & requests" }),
      state.user.kind === "Clinician" && state.requests?.inbox?.length ? h("span", { class: "count", text: String(state.requests.inbox.length) }) : null),
    h("div", { class: "user-chip" },
      h("div", { class: "who" }, h("strong", { text: state.user.name }), h("span", { text: state.user.role })),
      h("span", { class: "avatar", text: initials(state.user.name) }),
      h("button", { class: "btn ghost small", onclick: signOut, title: "Sign out" }, icon("logout", 16), h("span", { class: "name", text: "Sign out" })),
    ),
  );
}

const STATUS_TEXT = { pending: "waiting", approved: "approved", rejected: "declined" };

function requestsView() {
  const clinician = state.user.kind === "Clinician";
  const back = h("div", { class: "row-between" },
    state.patients.length > 0 ? h("button", { class: "btn ghost small", onclick: () => ((state.view = "main"), render()) }, "← Back") : h("span"),
    h("button", { class: "btn ghost small", onclick: showRequests, title: "Check for new answers" }, icon("memory", 14), "Refresh"),
  );
  if (!state.requests) return h("div", { class: "empty center" }, h("div", { class: "spinner" }));
  if (clinician) {
    const { inbox, patients } = state.requests;
    return h("div", { class: "center wide" },
      back,
      h("h2", { text: "Access requests" }),
      h("p", { class: "muted", text: "Patients asking you to join their care team, and family members asking for access to one of your patients. Approving creates the link in the graph; nobody gets access without you." }),
      inbox.length === 0 && h("div", { class: "empty" }, icon("inbox", 32), h("p", { text: "No pending requests." })),
      inbox.map((q) => {
        const note = h("textarea", { class: "input", rows: 2, placeholder: "Note (required to decline)", "aria-label": "Note" });
        const pick = q.kind === "caregiver" && h("select", { class: "input", "aria-label": "Which of your patients" },
          h("option", { value: "", text: patients.length ? "Which of your patients is this?" : "You have no patients to link" }),
          patients.map((p) => h("option", { value: p.id, text: `${p.name} (${p.age})`, selected: p.name.toLowerCase() === q.patient_name.toLowerCase() })));
        return h("div", { class: "review-item" },
          h("div", { class: "finding-head" },
            h("span", { class: "avatar sm", text: initials(q.from_name) }),
            h("strong", { text: q.from_name }),
            h("span", { class: "chip", text: q.from_kind === "Patient" ? `Patient${q.from_age ? `, ${q.from_age}` : ""}` : "Family caregiver" }),
            h("span", { class: "hint", text: day(q.created) }),
          ),
          h("p", { text: q.kind === "self" ? "Asks you to join their care team." : `Looks after “${q.patient_name}”${q.relation ? ` (${q.relation})` : ""} and asks for access.` }),
          q.message && h("div", { class: "note", text: `“${q.message}”` }),
          pick && h("div", { class: "field" }, h("label", { text: "Link to patient" }), pick),
          note,
          h("div", { class: "review-actions" },
            h("button", { class: "btn success", onclick: () => (q.kind === "caregiver" && !pick.value ? toast("Pick which of your patients this is.", "error") : decideAccess(q, "approved", pick?.value || undefined, note.value.trim())) }, icon("check", 16), "Approve"),
            h("button", { class: "btn danger", onclick: () => (note.value.trim() ? decideAccess(q, "rejected", undefined, note.value.trim()) : (note.focus(), toast("Add a reason before declining.", "error"))) }, icon("stop", 16), "Decline"),
          ),
        );
      }),
    );
  }
  const patient = state.user.kind === "Patient";
  const docs = state.clinicians || [];
  const chosen = docs.find((d) => d.id === state.reqDoctor);
  return h("div", { class: "center wide" },
    back,
    h("h2", { text: state.patients.length ? "Doctors & requests" : `Welcome, ${firstName(state.user.name)}` }),
    h("p", { class: "muted", text: patient
      ? "Choose a doctor to add to your care team. Once they approve, they can review your safety checks and update your record."
      : "Choose the doctor of the person you look after. Once they approve, you can check medicines for that person." }),
    h("input", { class: "input doc-search", type: "search", placeholder: `Search ${docs.length} doctors by name or specialty, e.g. "neuro"`, "aria-label": "Search doctors",
      oninput: (e) => {
        // Filter in place (no re-render) so typing keeps focus.
        const q = e.target.value.trim().toLowerCase();
        let shown = 0;
        for (const card of document.querySelectorAll(".doc-grid .patient-card")) {
          const hit = !q || card.dataset.search.includes(q);
          card.classList.toggle("hidden", !hit);
          shown += hit;
        }
        document.querySelector(".doc-none").classList.toggle("hidden", shown > 0);
      } }),
    h("p", { class: "muted doc-none hidden", text: "No doctor matches that search." }),
    h("div", { class: "patient-grid doc-grid" },
      docs.map((d) => h("button", { class: `patient-card ${state.reqDoctor === d.id ? "selected" : ""}`, "data-search": `${d.name} ${d.role}`.toLowerCase(), onclick: () => ((state.reqDoctor = d.id), render()) },
        h("span", { class: "avatar lg", text: initials(d.name) }),
        h("span", {}, h("strong", { text: d.name }), h("span", { class: "muted", text: d.role }), h("span", { class: "hint", text: `${d.patients} patient${d.patients === 1 ? "" : "s"}` })),
      )),
    ),
    chosen && h("form", { class: "card card-pad request-form", onsubmit: (e) => (e.preventDefault(), sendRequest(e.target)) },
      h("h3", { text: `Request ${chosen.name}` }),
      !patient && h("div", { class: "two" },
        h("div", { class: "field" }, h("label", { for: "patient_name", text: "Who do you look after?" }), h("input", { class: "input", id: "patient_name", name: "patient_name", required: true, placeholder: "Their full name", maxlength: 80 })),
        h("div", { class: "field" }, h("label", { for: "relation", text: "Your relationship" }), h("input", { class: "input", id: "relation", name: "relation", placeholder: "e.g. daughter", maxlength: 40 })),
      ),
      h("div", { class: "field" }, h("label", { for: "message", text: "Message (optional)" }), h("textarea", { class: "input", id: "message", name: "message", rows: 2, maxlength: 500 })),
      h("button", { class: "btn primary", type: "submit" }, icon("send", 16), "Send request"),
    ),
    h("h3", { class: "spaced", text: "Your requests" }),
    !state.requests.mine.length && h("p", { class: "muted", text: "None yet." }),
    h("ul", { class: "timeline" },
      state.requests.mine.map((r) => h("li", {},
        h("div", { class: "date", text: day(r.created) }),
        h("div", {},
          h("div", { class: "row" }, h("strong", { text: r.clinician }), h("span", { class: `status ${r.status}`, text: STATUS_TEXT[r.status] || r.status })),
          h("div", { class: "hint", text: r.kind === "self" ? "Join my care team" : `Access to ${r.patient || r.patient_name}` }),
          r.note && h("div", { class: "note", text: r.note }),
        ),
      )),
    ),
  );
}

function pickerView() {
  return h("div", { class: "center" },
    h("h2", { text: `Who are you helping today, ${firstName(state.user.name)}?` }),
    h("p", { class: "muted", text: "Everything you ask in a session is about the person you pick. You can switch any time." }),
    h("div", { class: "patient-grid" },
      state.patients.map((p) => h("button", { class: "patient-card", onclick: () => openSession(p.id).catch((e) => toast(e.message, "error")) },
        h("span", { class: "avatar lg", text: initials(p.name) }),
        h("span", {}, h("strong", { text: p.name }), h("span", { class: "muted", text: `Age ${p.age}` })),
      )),
    ),
  );
}

function sidebar() {
  const p = state.patient;
  const clinician = state.user.kind === "Clinician";
  const drugs = state.catalog?.drugs || [];
  return h("aside", { class: "side" },
    h("div", { class: "card" },
      h("div", { class: "card-head" },
        h("h3", { text: "Current medicines" }),
        h("button", { class: "btn small", onclick: () => ((state.editing = state.editing === "med" ? null : "med"), render()) }, icon("plus", 14), "Add"),
      ),
      state.editing === "med" && h("form", { class: "card-pad edit-form", onsubmit: (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        state.pendingAdd = { drug: String(f.get("drug")).trim(), dose: String(f.get("dose") || "").trim() };
        state.editing = null;
        runCheck(state.pendingAdd.drug); // safety check first; adding is a separate, informed click
      } },
        h("input", { class: "input", name: "drug", list: "drug-list", placeholder: "Medicine", required: true, "aria-label": "Medicine" }),
        h("input", { class: "input", name: "dose", placeholder: "Dose, e.g. 500 mg twice daily", "aria-label": "Dose", maxlength: 60 }),
        h("p", { class: "hint", text: clinician ? "Added as a prescription from you." : "Added as over the counter. Prescriptions are added by the doctor." }),
        h("button", { class: "btn primary small", type: "submit", text: "Check safety first" }),
      ),
      p.medications.length === 0 && h("p", { class: "card-pad muted", text: "No medicines recorded yet." }),
      h("ul", { class: "med-list" },
        p.medications.map((m) => h("li", {},
          h("span", { class: "pill-icon" }, icon("pill", 16)),
          h("div", { class: "grow" },
            h("strong", {}, m.brand, m.otc ? h("span", { class: "otc", text: "OTC" }) : null),
            h("div", { class: "sub", text: `${m.drug} · ${m.dose}` }),
            h("div", { class: "sub faint", text: m.prescriber ? `Prescribed by ${m.prescriber}` : m.added_by ? `Added by ${m.added_by}` : "Over the counter" }),
          ),
          (clinician || m.otc) && h("button", { class: "btn ghost small", title: `Stop ${m.brand}`, "aria-label": `Stop ${m.brand}`,
            onclick: () => editRecord("/patient/medications/stop", { drug: m.drug_id }, (x) => `Stopped ${x.drug}.`).then(render) }, "Stop"),
        )),
      ),
    ),
    h("datalist", { id: "drug-list" }, drugs.map((d) => h("option", { value: d.brand, label: d.name }))),
    h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", { text: "Care team" })),
      h("ul", { class: "team-list" },
        p.care_team.map((c) => h("li", {}, h("span", { class: "avatar sm", text: initials(c.name) }), h("div", {}, h("strong", { text: c.name }), h("span", { text: c.role })))),
        p.care_team.length === 0 && h("li", { class: "muted", text: "No doctor yet." }),
      ),
      !clinician && h("div", { class: "card-pad" }, h("button", { class: "btn small block", onclick: showRequests }, icon("plus", 14), "Request a doctor")),
    ),
  );
}

function recordEditors() {
  const clinician = state.user.kind === "Clinician";
  const cat = state.catalog || { conditions: [], allergens: [] };
  if (state.editing === "allergy")
    return h("form", { class: "inline-form", onsubmit: (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      editRecord("/patient/allergies", { allergen_id: f.get("allergen"), reaction: f.get("reaction") }, (x) => `Allergy to ${x.name} recorded.`).then(render);
    } },
      h("select", { class: "input", name: "allergen", required: true, "aria-label": "Allergic to" },
        h("option", { value: "", text: "Allergic to…" }),
        h("optgroup", { label: "Drug classes" }, cat.allergens.filter((a) => a.kind === "DrugClass").map((a) => h("option", { value: a.id, text: a.name }))),
        h("optgroup", { label: "Ingredients" }, cat.allergens.filter((a) => a.kind === "Ingredient").map((a) => h("option", { value: a.id, text: a.name }))),
      ),
      h("input", { class: "input", name: "reaction", placeholder: "Reaction, e.g. hives", maxlength: 80, "aria-label": "Reaction" }),
      h("button", { class: "btn primary small", type: "submit", text: "Save" }),
      h("button", { class: "btn ghost small", type: "button", onclick: () => ((state.editing = null), render()), text: "Cancel" }),
    );
  if (state.editing === "condition" && clinician)
    return h("form", { class: "inline-form", onsubmit: (e) => {
      e.preventDefault();
      editRecord("/patient/conditions", { condition_id: new FormData(e.target).get("condition") }, (x) => `${x.name} recorded.`).then(render);
    } },
      h("select", { class: "input", name: "condition", required: true, "aria-label": "Condition" },
        h("option", { value: "", text: "Condition…" }), cat.conditions.map((c) => h("option", { value: c.id, text: c.name }))),
      h("button", { class: "btn primary small", type: "submit", text: "Save" }),
      h("button", { class: "btn ghost small", type: "button", onclick: () => ((state.editing = null), render()), text: "Cancel" }),
    );
  return null;
}

function pathView(path) {
  const parts = String(path || "").split(/\s+(→|←|⟷|=)\s+/);
  const last = parts.length - 1;
  return h("div", { class: "path" },
    h("span", { class: "why", text: "Why" }),
    parts.map((t, i) => {
      if (i % 2) return h("span", { class: `arrow ${t === "⟷" ? "both" : ""}`, text: t === "⟷" ? "⇄" : t, title: t === "⟷" ? "interacts with" : "" });
      if (/^\[.*\]$/.test(t)) return h("span", { class: "node class", text: t.slice(1, -1) });
      if (/^[A-Z_]+$/.test(t)) return h("span", { class: "node rel", text: t.toLowerCase().replace(/_/g, " ") });
      if (t === "patient") return h("span", { class: "node end", text: state.session.patient.name });
      return h("span", { class: `node ${i === 0 || i === last ? "end" : ""}`, text: t });
    }),
  );
}

const FINDING_TITLE = {
  interaction: (f) => `Interacts with ${f.with}`,
  condition: () => "Not advised with a health condition",
  age: () => "Extra caution at this age",
  allergy: () => "Allergy on file",
  duplicate: (f) => `Same ingredient as ${f.with}`,
  duplicate_class: (f) => `Same kind of medicine as ${f.with}`,
  already_taking: () => "Already on the medicine list",
};

function checkResult() {
  const c = state.check;
  if (state.checking) return h("div", { class: "empty" }, h("div", { class: "spinner" }), h("p", { text: "Walking the graph: ingredients, drug classes, conditions, allergies, age, prescribers…" }));
  if (!c) return h("div", { class: "empty" }, icon("search", 32), h("p", { text: `Type a medicine ${firstName(state.session.patient.name)} might take, for example from the pharmacy shelf or a new prescription.` }));
  if (c.error) return h("div", { class: "result" }, h("div", { class: "callout" }, icon("alert"), h("span", { text: c.error })));
  const L = LEVELS[c.level];
  const label = c.drug.brand && c.drug.brand !== c.drug.name ? `${c.drug.brand} (${c.drug.name})` : c.drug.name;
  const findings = c.findings.filter((f) => f.type !== "llm_error");
  return h("div", { class: "result" },
    h("div", { class: `verdict ${c.level}`, role: "status" },
      h("div", { class: "icon" }, icon(L.icon, 22)),
      h("div", {},
        h("div", { class: "level", text: L.label }),
        h("h2", { text: `${L.title}: ${label}` }),
        h("p", { text: L.advice }),
      ),
    ),
    c.prior.map((r) => h("div", { class: "callout memory" }, icon("memory"),
      h("span", {},
        h("strong", { text: r.status === "rejected" ? `${r.reviewer} decided not to start this` : `${r.reviewer} approved this` }),
        ` on ${day(r.reviewed_at || r.ts)}: “${r.note}”`,
        r.status === "rejected" ? " Don't raise it again without new information." : "",
      ),
    )),
    c.explanation && h("div", { class: "callout" }, icon("chat"), h("div", {}, h("strong", { text: "In plain words" }), md(c.explanation))),
    findings.length > 0 && h("div", { class: "section-title", text: `What the graph found (${findings.length})` }),
    findings.map((f) => h("div", { class: "finding" },
      h("div", { class: "finding-head" }, h("span", { class: `sev ${f.severity}`, text: f.severity.toUpperCase() }), h("strong", { text: (FINDING_TITLE[f.type] || (() => f.type))(f) })),
      h("p", { text: f.message }),
      f.path && pathView(f.path),
    )),
    (c.contacts.length > 0 || c.safer.length > 0) && h("div", { class: "two" },
      c.contacts.length > 0 && h("div", { class: "card card-pad" },
        h("h3", { text: "Who to contact" }),
        c.contacts.map((p) => h("div", { class: "contact" }, h("span", { class: "avatar sm", text: initials(p.name) }), h("div", {}, h("strong", { text: p.name }), h("span", { text: p.why })))),
      ),
      c.safer.length > 0 && h("div", { class: "card card-pad" },
        h("h3", { text: "Options with fewer conflicts" }),
        c.safer.map((s) => h("div", { class: "alt" },
          h("div", {}, h("strong", { text: s.drug }), h("div", { class: "hint", text: s.alreadyTaking ? "Already on the list" : s.level === "monitor" ? "Needs monitoring" : `For ${s.indication.toLowerCase()}` })),
          h("button", { class: "btn small", onclick: () => runCheck(s.drug), text: "Check" }),
        )),
        h("p", { class: "hint", text: "Ask the clinician before switching." }),
      ),
    ),
    state.pendingAdd && [c.drug.brand, c.drug.name].some((n) => n?.toLowerCase() === state.pendingAdd.drug.toLowerCase()) &&
      h("div", { class: "callout add-confirm" },
        icon(c.level === "stop" || c.level === "caution" ? "alert" : "plus"),
        h("div", { class: "grow" },
          h("strong", { text: c.level === "stop" || c.level === "caution" ? `Add ${label} to the list anyway?` : `Add ${label} to the medicine list?` }),
          h("div", { class: "hint", text: c.level === "stop" || c.level === "caution" ? "Recording it keeps every future check accurate. Please talk to the care team about the warnings above." : `Dose: ${state.pendingAdd.dose || "as directed"}` }),
        ),
        h("button", { class: "btn primary small", onclick: async () => {
          const add = state.pendingAdd;
          state.pendingAdd = null;
          await editRecord("/patient/medications", add, (x) => `Added ${x.drug}${x.prescribed ? " as a prescription" : ""}.`);
          render();
        } }, "Add to medicine list"),
        h("button", { class: "btn ghost small", onclick: () => ((state.pendingAdd = null), render()), text: "Not now" }),
      ),
    h("div", { class: "status-line" },
      h("span", {}, "Saved as ", h("span", { class: "mono", text: c.actionId }), " · ", h("span", { class: "status pending", text: "waiting for clinician review" })),
      h("span", { class: "faint", text: "Decision aid on demo data, not medical advice." }),
    ),
  );
}

function checkTab() {
  const quick = ["Advil", "Tylenol", "NyQuil", "Mucinex", "Aleve", "Amoxil", "Biaxin"];
  return [
    h("form", { class: "check-form", onsubmit: (e) => (e.preventDefault(), runCheck(new FormData(e.target).get("drug"))) },
      h("input", { class: "input", name: "drug", list: "drug-list", placeholder: "Medicine name or brand, e.g. Advil", "aria-label": "Medicine to check", autocomplete: "off", required: true }),
      h("button", { class: "btn primary", type: "submit", disabled: state.checking }, state.checking ? h("span", { class: "spinner" }) : icon("shield", 16), "Check safety"),
    ),
    h("div", { class: "quick" }, h("span", { class: "label", text: "Try:" }), quick.map((q) => h("button", { class: "chip clickable", type: "button", onclick: () => runCheck(q), text: q }))),
    checkResult(),
  ];
}

function askTab() {
  const name = firstName(state.session.patient.name);
  const ideas = [`What is ${name} taking?`, `Can ${name} take Advil for a headache?`, "Is NyQuil okay for a cold?", "What did we decide about Biaxin?", "Who is on the care team?"];
  const log = h("div", { class: "chat-log" },
    state.chat.length === 0 && h("div", { class: "empty" }, icon("chat", 32), h("p", { text: `Ask anything about ${state.session.patient.name}'s medicines. Answers come only from the graph.` }),
      h("div", { class: "quick" }, ideas.map((q) => h("button", { class: "chip clickable", onclick: () => sendQuestion(q), text: q })))),
    state.chat.map((m) => m.role === "user"
      ? h("div", { class: "msg user", text: m.text })
      : h("div", { class: "msg bot" }, md(m.text), m.trace?.length ? h("details", {}, h("summary", { text: "Graph steps" }), h("pre", { text: m.trace.join("\n") })) : null)),
    state.asking && h("div", { class: "msg bot" }, h("span", { class: "typing", "aria-label": "Thinking" }, h("i"), h("i"), h("i"))),
  );
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      e.target.form.requestSubmit();
    }
  };
  return h("div", { class: "chat" },
    log,
    h("form", { class: "chat-form", onsubmit: (e) => { e.preventDefault(); const t = e.target.elements.q; const v = t.value; t.value = ""; sendQuestion(v); } },
      h("textarea", { class: "input", name: "q", rows: 1, placeholder: `Ask about ${name}…`, "aria-label": "Your question", onkeydown: onKey, disabled: state.asking }),
      h("button", { class: "btn primary", type: "submit", disabled: state.asking, "aria-label": "Send" }, icon("send", 16)),
    ),
  );
}

function historyTab() {
  const items = (state.history || []).filter((x) => x.kind === "check");
  if (!items.length) return h("div", { class: "empty" }, icon("clock", 32), h("p", { text: "No safety checks yet for this patient." }));
  return h("ul", { class: "timeline" },
    items.map((x) => h("li", {},
      h("div", { class: "date", text: day(x.ts) }),
      h("div", {},
        h("div", { class: "row" },
          h("strong", { text: x.drug || "?" }),
          h("span", { class: `sev ${x.level === "stop" ? "major" : x.level === "caution" ? "moderate" : x.level === "monitor" ? "minor" : "info"}`, text: (LEVELS[x.level]?.label || x.level || "").toUpperCase() }),
          h("span", { class: `status ${x.status}`, text: x.status }),
        ),
        h("div", { class: "hint", text: x.asked_by ? `Checked by ${x.asked_by}` : "" }),
        x.reviewer && h("div", { class: "note" }, h("strong", { text: `${x.reviewer}: ` }), x.note || "(no note)"),
      ),
    )),
  );
}

function reviewTab() {
  const items = state.pending || [];
  return [
    h("p", { class: "muted", text: `Checks for ${state.session.patient.name} waiting for a clinician. Your decision is stored in the graph and shown to the family next time.` }),
    items.length === 0 && h("div", { class: "empty" }, icon("inbox", 32), h("p", { text: "Nothing waiting for review." })),
    items.map((p) => {
      const note = h("textarea", { class: "input", rows: 2, placeholder: "Note for the family (required to reject)", "aria-label": `Note for ${p.drug}` });
      return h("div", { class: "review-item" },
        h("div", { class: "finding-head" },
          h("strong", { text: p.drug }),
          h("span", { class: `sev ${p.level === "stop" ? "major" : p.level === "caution" ? "moderate" : p.level === "monitor" ? "minor" : "info"}`, text: (LEVELS[p.level]?.label || p.level).toUpperCase() }),
          h("span", { class: "hint", text: `asked by ${p.asked_by} · ${day(p.ts)} · ` }), h("span", { class: "mono faint", text: p.id }),
        ),
        h("pre", { text: p.summary || "" }),
        note,
        h("div", { class: "review-actions" },
          h("button", { class: "btn success", onclick: () => decide(p.id, "approved", note.value.trim()) }, icon("check", 16), "Approve (OK to start)"),
          h("button", { class: "btn danger", onclick: () => (note.value.trim() ? decide(p.id, "rejected", note.value.trim()) : (note.focus(), toast("Add a reason before rejecting.", "error"))) }, icon("stop", 16), "Reject (do not start)"),
        ),
      );
    }),
  ];
}

function workspace() {
  const p = state.patient;
  const s = state.session;
  const clinician = state.user.kind === "Clinician";
  const tabs = [
    ["check", "Check a medicine", "shield"],
    ["ask", "Ask the assistant", "chat"],
    ["history", "History", "clock"],
    ...(clinician ? [["review", "Review queue", "inbox"]] : []),
  ];
  const body = { check: checkTab, ask: askTab, history: historyTab, review: reviewTab }[state.tab]();
  return h("main", { class: "page" },
    h("div", { class: "banner" }, icon("alert", 16), h("span", { text: "Decision aid on illustrative demo data. Not medical advice: a clinician on the care team must confirm every decision." })),
    h("section", { class: "card hero" },
      h("span", { class: "avatar lg", text: initials(s.patient.name) }),
      h("div", {},
        h("h1", { text: s.patient.name }),
        h("div", { class: "meta", text: `Age ${s.patient.age} · ${p.medications.length} current medicines` }),
        h("div", { class: "chips" },
          p.conditions.map((c) => h("span", { class: "chip condition", text: c })),
          p.allergies.map((a) => h("span", { class: "chip allergy" }, icon("alert", 12), `Allergy: ${a}`)),
          p.conditions.length + p.allergies.length === 0 && h("span", { class: "chip", text: "No conditions or allergies recorded" }),
          h("button", { class: "chip clickable", onclick: () => ((state.editing = "allergy"), render()) }, icon("plus", 12), "Allergy"),
          clinician && h("button", { class: "chip clickable", onclick: () => ((state.editing = "condition"), render()) }, icon("plus", 12), "Condition"),
        ),
        recordEditors(),
      ),
      h("div", { class: "session-id" }, "Session ", h("span", { class: "mono", text: s.id }), h("br"), `Signed in as ${state.user.role.toLowerCase()}`),
    ),
    h("div", { class: "layout" },
      sidebar(),
      h("section", { class: "card" },
        h("div", { class: "tabs", role: "tablist" },
          tabs.map(([id, label, ic]) => h("button", { role: "tab", "aria-selected": String(state.tab === id), onclick: () => ((state.tab = id), render()) },
            icon(ic, 16), label, id === "review" && state.pending?.length ? h("span", { class: "count", text: String(state.pending.length) }) : null)),
        ),
        h("div", { class: "tab-body" }, body),
      ),
    ),
  );
}

function render() {
  const root = document.getElementById("app");
  const chatScroll = state.tab === "ask";
  let view;
  if (!state.booted) view = h("div", { class: "empty center" }, h("div", { class: "spinner" }));
  else if (!state.user) view = authView();
  else {
    let main;
    if (state.view === "requests" || state.patients.length === 0) main = h("main", { class: "page" }, requestsView());
    else if (!state.session || !state.patient) main = h("main", { class: "page" }, pickerView());
    else main = workspace();
    view = [topbar(), main];
  }
  root.replaceChildren(...[view].flat());
  if (chatScroll) {
    const log = root.querySelector(".chat-log");
    if (log) log.scrollTop = log.scrollHeight;
  }
}

document.addEventListener("click", (e) => {
  if (state.menu && !e.target.closest(".switcher")) {
    state.menu = false;
    render();
  }
});

// ---------------------------------------------------------------- boot
(async () => {
  render();
  try {
    await refresh(); // restores the login from the HttpOnly cookie, and the patient session if still allowed
    await afterSignIn();
  } catch {
    /* not signed in */
  }
  state.booted = true;
  render();
})();
