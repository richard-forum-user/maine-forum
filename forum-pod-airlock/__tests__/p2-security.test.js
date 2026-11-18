// P2 error leakage, security.txt, and the already-removed dead worker vars.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalise } from "../canonical-json.js";
import { AUD_A, makeDevice, makeEnv, postPod, worker } from "./harness.js";

test("P2-1 nested bundle fields still verify on the pod", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });
  const listed = await postPod(env, owner, {
    verb: "LIST",
    path: "/devices",
    data: { z: 1, nested: { b: 2, a: 1 } },
  });
  assert.equal(listed.status, 200);
  assert.equal(
    canonicalise({ z: 1, nested: { b: 2, a: 1 } }),
    canonicalise({ nested: { a: 1, b: 2 }, z: 1 })
  );
});

test("P2-2 pod errors do not echo handler details or the path", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });
  const missing = await postPod(env, owner, { verb: "GET", path: "/no/such", data: null });
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { error: "route_not_found" });

  const failed = await postPod(env, owner, { verb: "LIST", path: "/threads", data: null });
  assert.equal(failed.status, 500);
  assert.deepEqual(failed.body, { error: "handler_failed" });

  const res = await worker.fetch(new Request(`${AUD_A}/api/not-a-route`, { method: "POST" }), env);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "route_not_found" });
});

test("P2-5 security.txt comes from config and the placeholder is gone", async () => {
  const env = makeEnv();
  const absent = await worker.fetch(new Request(`${AUD_A}/.well-known/security.txt`), env);
  assert.equal(absent.status, 404);
  const absentBody = await absent.text();
  assert.equal(absentBody.includes("yourcommunity.forum"), false);

  const configured = makeEnv();
  configured.SECURITY_CONTACT = "mailto:security@example.com";
  configured.PUBLIC_POD_URL = AUD_A;
  const present = await worker.fetch(new Request(`${AUD_A}/.well-known/security.txt`), configured);
  assert.equal(present.status, 200);
  const text = await present.text();
  assert.match(text, /^Contact: mailto:security@example.com/m);
  assert.match(text, new RegExp(`Canonical: ${AUD_A}/\\.well-known/security.txt`));
  assert.equal(text.includes("yourcommunity.forum"), false);
});

test("P2-6 the removed WebAuthn worker vars stay out of wrangler.toml", () => {
  const src = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.equal(src.includes("WEBAUTHN_ALLOWED_ORIGINS"), false);
  assert.equal(src.includes("ALLOW_PILOT_BUNDLES"), false);
});
