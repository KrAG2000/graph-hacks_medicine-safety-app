/**
 * HTTP API (JSON). Auth: Bearer access token (JWT, 15 min) + rotating refresh token (JWT, 7 days).
 *
 * Public:   POST /auth/register {username,password,name}   POST /auth/login {username,password}
 *           POST /auth/refresh {refresh_token, session_id?} POST /auth/logout {refresh_token}
 * User:     GET /me   POST /sessions {patient_id}   GET /catalog   GET /clinicians
 *           POST /requests {clinician_id, patient_name?, relation?, message?}   GET /requests (sent, or a clinician's inbox)
 * Session:  GET /patient   POST /ask {question}   POST /check {drug}   GET /history?drug=
 *           POST /patient/medications {drug, dose}   POST /patient/medications/stop {drug}
 *           POST /patient/allergies {allergen_id, reaction}   POST /patient/conditions {condition_id} (clinician)
 * Clinician: POST /requests/decide {request_id, decision, patient_id?, note}
 *            (session) GET /pending   POST /reviews {action_id, decision, note}
 * Web UI:   GET /  (static files from public/)
 *
 * Browser clients send `X-Client: web`. For them the refresh token is never put in a JSON body: it lives in an
 * HttpOnly, SameSite=Strict cookie scoped to /auth, and is only read from the cookie when that header is present
 * (a cross-site page can't add the header without a CORS preflight, which this server never allows).
 */
import http from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { connect, GRAPH_NAME } from "./db.js";
import { createLLM } from "./llm.js";
import {
  login, register, getUser, getSession, patientsFor, openSession, AuthError, LoginThrottle,
  clinicians, requestAccess, myRequests, inbox, decideRequest,
} from "./auth.js";
import { catalog, addMedication, stopMedication, addCondition, addAllergy } from "./care.js";
import { issueTokens, rotate, revoke, verifyAccess, accessToken, REFRESH_TTL } from "./tokens.js";
import { TokenError } from "./jwt.js";
import { history, pendingChecks, reviewAction } from "./memory.js";
import { patientInfo } from "./tools.js";
import { ask } from "./agents/assistant.js";
import { checkMedication } from "./agents/checker.js";

const fail = (status, code, message) => {
  throw new AuthError(status, code, message);
};

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) fail(413, "too_large", "Request body too large.");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString());
    return v && typeof v === "object" ? v : {};
  } catch {
    fail(400, "bad_json", "Body must be JSON.");
  }
}

const COOKIE = "msg_refresh";
const isWeb = (req) => req.headers["x-client"] === "web";

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function cookie(req, value, maxAge) {
  const secure = process.env.COOKIE_SECURE === "1" || req.headers["x-forwarded-proto"] === "https";
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/auth; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** Token responses: CLI gets both tokens in JSON; the browser gets the refresh token as a cookie only. */
function deliver(req, status, payload) {
  if (!isWeb(req)) return [status, payload];
  const { refresh_token, refresh_expires_in: _r, ...rest } = payload;
  return [status, rest, { "set-cookie": cookie(req, refresh_token, REFRESH_TTL) }];
}

const refreshFrom = (req, b) => b.refresh_token || (isWeb(req) ? readCookie(req, COOKIE) : null);

const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/styles.css": ["styles.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
};
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

function serveStatic(req, res, pathname) {
  const entry = STATIC[pathname];
  if (!["GET", "HEAD"].includes(req.method) || !entry) return false;
  let file;
  try {
    file = readFileSync(new URL(`../public/${entry[0]}`, import.meta.url));
  } catch {
    return false;
  }
  res.writeHead(200, {
    "content-type": entry[1],
    "content-length": file.length,
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-cache",
  });
  res.end(req.method === "HEAD" ? undefined : file);
  return true;
}

export function createApp(graph, { llm = createLLM(), throttle = new LoginThrottle(), log = () => {} } = {}) {
  /** Resolve the Bearer token into {user, session}. Re-checks the account and CARES_FOR on every request. */
  async function authenticate(req, { needSession = false, clinician = false } = {}) {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!m) fail(401, "unauthorized", "Missing Bearer token.");
    const claims = verifyAccess(m[1]);
    const user = await getUser(graph, claims.sub);
    if (!user) fail(401, "invalid_token", "Account no longer exists.");
    const session = claims.sid ? await getSession(graph, user, claims.sid) : null;
    if (claims.sid && !session) fail(403, "access_revoked", "You no longer have access to this patient.");
    if (needSession && !session) fail(409, "no_session", "Pick a patient first (POST /sessions).");
    if (clinician && user.kind !== "Clinician") fail(403, "forbidden", "Clinicians only.");
    return { user, session };
  }

  const routes = {
    "POST /auth/register": async (req) => {
      const user = await register(graph, await body(req));
      return deliver(req, 201, { user, ...(await issueTokens(graph, user)) });
    },
    "POST /auth/login": async (req) => {
      const { username = "", password = "" } = await body(req);
      const addr = req.socket.remoteAddress;
      if (throttle.blocked(username, addr)) fail(429, "too_many_attempts", "Too many failed logins. Try again later.");
      const user = await login(graph, username, password);
      if (!user) {
        throttle.fail(username, addr);
        fail(401, "invalid_credentials", "Invalid username or password.");
      }
      throttle.success(username, addr);
      return deliver(req, 200, { user, ...(await issueTokens(graph, user)) });
    },
    "POST /auth/refresh": async (req) => {
      const b = await body(req);
      const session_id = b.session_id ?? null;
      const r = await rotate(graph, refreshFrom(req, b), {
        loadUser: (id) => getUser(graph, id),
        loadSession: (user) => getSession(graph, user, session_id),
      });
      return deliver(req, 200, { user: r.user, session: r.session && view(r.session), ...r.tokens });
    },
    "POST /auth/logout": async (req) => {
      const token = refreshFrom(req, await body(req));
      if (isWeb(req)) {
        // Always clear the cookie, even if the token was already invalid.
        await revoke(graph, token).catch(() => {});
        return [200, { ok: true }, { "set-cookie": cookie(req, "", 0) }];
      }
      await revoke(graph, token);
      return [200, { ok: true }];
    },
    "GET /me": async (req) => {
      const { user, session } = await authenticate(req);
      return [200, { user, session: session && view(session), patients: await patientsFor(graph, user.id) }];
    },
    "POST /sessions": async (req) => {
      const { user } = await authenticate(req);
      const { patient_id } = await body(req);
      const session = await openSession(graph, user, String(patient_id || ""));
      if (!session) fail(403, "forbidden", "You are not on this patient's care team.");
      // New access token pinned to this session/patient. The refresh token is unchanged.
      return [201, { session: view(session), access_token: accessToken(user, session) }];
    },
    "GET /clinicians": async (req) => {
      await authenticate(req);
      return [200, { clinicians: await clinicians(graph) }];
    },
    "POST /requests": async (req) => {
      const { user } = await authenticate(req);
      return [201, { request: await requestAccess(graph, user, await body(req)) }];
    },
    "GET /requests": async (req) => {
      const { user } = await authenticate(req);
      if (user.kind === "Clinician")
        return [200, { inbox: await inbox(graph, user.id), patients: await patientsFor(graph, user.id) }];
      return [200, { mine: await myRequests(graph, user.id) }];
    },
    "POST /requests/decide": async (req) => {
      const { user } = await authenticate(req, { clinician: true });
      const { request_id, ...decision } = await body(req);
      return [200, await decideRequest(graph, user.id, request_id, decision)];
    },
    "GET /catalog": async (req) => {
      await authenticate(req);
      return [200, await catalog(graph)];
    },
    "GET /patient": async (req) => {
      const { session } = await authenticate(req, { needSession: true });
      return [200, { patient: session.patient, ...(await patientInfo(graph, session.patient.id, "all")) }];
    },
    "POST /patient/medications": async (req) => {
      const { user, session } = await authenticate(req, { needSession: true });
      return [201, await addMedication(graph, user, session.patient.id, await body(req))];
    },
    "POST /patient/medications/stop": async (req) => {
      const { user, session } = await authenticate(req, { needSession: true });
      return [200, await stopMedication(graph, user, session.patient.id, await body(req))];
    },
    "POST /patient/conditions": async (req) => {
      const { user, session } = await authenticate(req, { needSession: true });
      return [201, await addCondition(graph, user, session.patient.id, await body(req))];
    },
    "POST /patient/allergies": async (req) => {
      const { user, session } = await authenticate(req, { needSession: true });
      return [201, await addAllergy(graph, user, session.patient.id, await body(req))];
    },
    "POST /ask": async (req) => {
      const { session } = await authenticate(req, { needSession: true });
      const { question } = await body(req);
      if (!question || String(question).length > 2000) fail(400, "bad_question", "question: 1-2000 characters.");
      const trace = [];
      const answer = await ask(graph, llm, String(question), session, { log: (m) => trace.push(m) });
      return [200, { answer, trace }];
    },
    "POST /check": async (req) => {
      const { session } = await authenticate(req, { needSession: true });
      const { drug } = await body(req);
      const c = await checkMedication(graph, session.patient.id, String(drug || ""), { session: session.id, llm });
      if (c.error) fail(404, "not_found", c.error);
      const { patient: _p, ...rest } = c;
      return [200, rest];
    },
    "GET /history": async (req, url) => {
      const { session } = await authenticate(req, { needSession: true });
      return [200, { history: await history(graph, { patient: session.patient.id, drug: url.searchParams.get("drug") || "" }) }];
    },
    "GET /pending": async (req) => {
      const { session } = await authenticate(req, { needSession: true, clinician: true });
      return [200, { pending: await pendingChecks(graph, session.patient.id) }];
    },
    "POST /reviews": async (req) => {
      const { user, session } = await authenticate(req, { needSession: true, clinician: true });
      const { action_id, decision, note = "" } = await body(req);
      if (!["approved", "rejected"].includes(decision)) fail(400, "bad_decision", "decision: approved | rejected");
      if (decision === "rejected" && !String(note).trim()) fail(400, "note_required", "A rejection needs a reason.");
      const r = await reviewAction(graph, String(action_id || ""), user.id, decision, String(note), session.patient.id);
      if (!r.length) fail(404, "not_found", "No pending check with that id for this session's patient.");
      return [200, { id: r[0].id, patient: r[0].patient, decision }];
    },
  };

  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (serveStatic(req, res, url.pathname)) return;
    const route = routes[`${req.method} ${url.pathname}`];
    let status = 500;
    let out;
    let headers = {};
    try {
      if (!route) fail(404, "not_found", `No route ${req.method} ${url.pathname}`);
      [status, out, headers = {}] = await route(req, url);
    } catch (e) {
      if (e instanceof TokenError) [status, out] = [401, { error: { code: e.code, message: e.message } }];
      else if (e instanceof AuthError) [status, out] = [e.status, { error: { code: e.code, message: e.message } }];
      else {
        log(`[error] ${req.method} ${url.pathname}: ${e.stack || e.message}`);
        out = { error: { code: "server_error", message: "Something went wrong." } };
      }
    }
    log(`${req.method} ${url.pathname} ${status}`);
    const json = JSON.stringify(out);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-length": Buffer.byteLength(json),
      ...headers,
    });
    res.end(json);
  };
}

const view = (s) => ({ id: s.id, patient: s.patient });

export async function startServer({ port = Number(process.env.PORT || 8787), host = process.env.HOST || "127.0.0.1", graph, llm, log } = {}) {
  const server = http.createServer(createApp(graph, { llm, log }));
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}

// `npm start`
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let db, graph;
  try {
    ({ db, graph } = await connect());
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  const llm = createLLM();
  const server = await startServer({ graph, llm, log: (m) => console.log(new Date().toISOString(), m) });
  const { address, port } = server.address();
  console.log(`Web UI + API on http://${address}:${port}  graph "${GRAPH_NAME}"  LLM ${llm.name}`);
  const stop = () => server.close(() => db.close().then(() => process.exit(0)));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
