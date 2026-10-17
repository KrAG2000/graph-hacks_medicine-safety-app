import { test } from "node:test";
import assert from "node:assert/strict";
import { sign, verify, TokenError } from "../src/jwt.js";
import { LoginThrottle } from "../src/auth.js";

const S = "a".repeat(32);
const S2 = "b".repeat(32);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

test("jwt: round trip with standard claims", () => {
  const t = sign({ sub: "u1", typ: "access" }, S, { expiresIn: 60 });
  const c = verify(t, S, { typ: "access" });
  assert.equal(c.sub, "u1");
  assert.equal(c.iss, "med-safety-graph");
  assert.equal(c.exp - c.iat, 60);
  assert.match(c.jti, /^[0-9a-f]{24}$/);
});

test("jwt: rejects tampering, wrong secret, wrong type, alg none, garbage", () => {
  const t = sign({ sub: "u1", typ: "access" }, S, { expiresIn: 60 });
  const [h, , s] = t.split(".");
  const forged = `${h}.${b64({ sub: "admin", typ: "access", iss: "med-safety-graph", exp: 9e9 })}.${s}`;
  assert.throws(() => verify(forged, S), /bad signature/);
  assert.throws(() => verify(t, S2), /bad signature/);
  assert.throws(() => verify(t, S, { typ: "refresh" }), /expected a refresh token/);
  const none = `${b64({ alg: "none", typ: "JWT" })}.${b64({ sub: "x", iss: "med-safety-graph", exp: 9e9 })}.`;
  assert.throws(() => verify(none, S), /unsupported algorithm/);
  assert.throws(() => verify("not.a.jwt", S), TokenError);
  assert.throws(() => verify("", S), /malformed/);
});

test("jwt: expiry is reported as token_expired (with leeway), and can be ignored for logout", () => {
  const t = sign({ typ: "refresh" }, S, { expiresIn: 60, now: Date.now() - 3600e3 });
  assert.throws(() => verify(t, S), (e) => e.code === "token_expired");
  assert.equal(verify(t, S, { ignoreExpiry: true }).typ, "refresh");
  const justNow = sign({}, S, { expiresIn: 1, now: Date.now() - 3000 });
  assert.ok(verify(justNow, S)); // within the 5 s leeway
});

test("login throttle: 5 failures lock that username+address, success clears", () => {
  const th = new LoginThrottle({ max: 5, windowMs: 60e3 });
  for (let i = 0; i < 4; i++) th.fail("Priya", "1.2.3.4");
  assert.equal(th.blocked("priya", "1.2.3.4"), false);
  th.fail("priya", "1.2.3.4");
  assert.equal(th.blocked("priya", "1.2.3.4"), true);
  assert.equal(th.blocked("priya", "5.6.7.8"), false);
  th.success("priya", "1.2.3.4");
  assert.equal(th.blocked("priya", "1.2.3.4"), false);
});
