/**
 * API client used by the CLI and the demo. Keeps {access_token, refresh_token, session} in a store,
 * attaches the access token, and on 401 token_expired refreshes once (rotating the refresh token) and retries.
 */
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Credentials on disk, readable only by you (like ~/.config/gh/hosts.yml). */
export function fileStore(path = process.env.MSG_CREDENTIALS || join(homedir(), ".config", "med-safety-graph", "credentials.json")) {
  return {
    path,
    async load() {
      try {
        return JSON.parse(await readFile(path, "utf8"));
      } catch {
        return null;
      }
    },
    async save(v) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, JSON.stringify(v, null, 2), { mode: 0o600 });
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

export function memoryStore() {
  let v = null;
  return { load: async () => v, save: async (x) => void (v = x), clear: async () => void (v = null) };
}

export class Client {
  constructor(baseUrl = process.env.MSG_API_URL || "http://127.0.0.1:8787", store = memoryStore()) {
    Object.assign(this, { baseUrl, store, creds: null });
  }

  async init() {
    this.creds = await this.store.load();
    return this.creds;
  }

  async #save(patch) {
    this.creds = { ...(this.creds || {}), ...patch };
    await this.store.save(this.creds);
  }

  async #raw(method, path, body, token) {
    let res;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError(0, "unreachable", `Cannot reach the API at ${this.baseUrl} (${e.cause?.code || e.message}). Start it with \`npm start\`.`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data.error?.code || "error", data.error?.message || res.statusText);
    return data;
  }

  /** Authenticated request with one automatic refresh on an expired access token. */
  async request(method, path, body) {
    if (!this.creds?.access_token) throw new ApiError(401, "not_logged_in", "Not logged in.");
    try {
      return await this.#raw(method, path, body, this.creds.access_token);
    } catch (e) {
      if (e.code === "access_revoked") await this.#save({ session: null }); // removed from the care team
      if (e.status === 401 && e.code !== "token_expired") {
        // Bad signature (e.g. server secrets changed) or deleted account: start over.
        await this.store.clear();
        this.creds = null;
        throw new ApiError(401, "session_ended", `Your login is no longer valid (${e.message}). Please log in again.`);
      }
      if (e.code !== "token_expired") throw e;
      await this.refresh();
      return this.#raw(method, path, body, this.creds.access_token);
    }
  }

  async #signedIn(data) {
    const { user, access_token, refresh_token } = data;
    await this.#save({ user, access_token, refresh_token, session: null });
    return user;
  }

  async register(username, password, name) {
    return this.#signedIn(await this.#raw("POST", "/auth/register", { username, password, name }));
  }

  async login(username, password) {
    return this.#signedIn(await this.#raw("POST", "/auth/login", { username, password }));
  }

  /** Rotate tokens. If the refresh token is rejected, local credentials are cleared: log in again. */
  async refresh() {
    try {
      const d = await this.#raw("POST", "/auth/refresh", {
        refresh_token: this.creds?.refresh_token,
        session_id: this.creds?.session?.id ?? null,
      });
      await this.#save({ user: d.user, access_token: d.access_token, refresh_token: d.refresh_token, session: d.session });
      return d;
    } catch (e) {
      if (e.status === 401) {
        await this.store.clear();
        this.creds = null;
        throw new ApiError(401, "session_ended", `Your login has ended (${e.message}). Please log in again.`);
      }
      throw e;
    }
  }

  async logout() {
    if (this.creds?.refresh_token)
      await this.#raw("POST", "/auth/logout", { refresh_token: this.creds.refresh_token }).catch(() => {});
    await this.store.clear();
    this.creds = null;
  }

  async openSession(patientId) {
    const d = await this.request("POST", "/sessions", { patient_id: patientId });
    await this.#save({ access_token: d.access_token, session: d.session });
    return d.session;
  }

  me = () => this.request("GET", "/me");
  acceptInvite = (code) => this.request("POST", "/invites/accept", { code });
  createInvite = () => this.request("POST", "/invites");
  patient = () => this.request("GET", "/patient");
  ask = (question) => this.request("POST", "/ask", { question });
  check = (drug) => this.request("POST", "/check", { drug });
  history = (drug = "") => this.request("GET", `/history?drug=${encodeURIComponent(drug)}`);
  pending = () => this.request("GET", "/pending");
  review = (action_id, decision, note = "") => this.request("POST", "/reviews", { action_id, decision, note });
}
