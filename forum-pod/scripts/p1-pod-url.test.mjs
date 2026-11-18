// P1-5 delivery-target checks and the envelope field rules shared with the pod.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ENVELOPE_ALG as POD_ALG,
  ENVELOPE_VERSION as POD_VERSION,
  envelopeFieldError,
  isDeliverablePodUrl,
} from "../../forum-pod-airlock/pod-url.js";
import { ENVELOPE_ALG, ENVELOPE_VERSION } from "../src/messaging/crypto.js";

test("P1-5 only https hostnames are deliverable pod URLs", () => {
  assert.equal(isDeliverablePodUrl("https://bob.example"), true);
  assert.equal(isDeliverablePodUrl("https://bob.example/pod"), true);
  for (const url of [
    "http://bob.example",
    "https://localhost",
    "https://pod.localhost",
    "https://127.0.0.1",
    "https://10.1.2.3",
    "https://192.168.0.4",
    "https://172.16.5.5",
    "https://169.254.1.1",
    "https://[::1]",
    "https://[fd00::1]",
    "https://user:pass@bob.example",
    "not a url",
  ]) {
    assert.equal(isDeliverablePodUrl(url), false, url);
  }
});

test("P1-1 envelope rules match the client constants", () => {
  assert.equal(POD_ALG, ENVELOPE_ALG);
  assert.equal(POD_VERSION, ENVELOPE_VERSION);
  const ts = new Date().toISOString();
  const ok = {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    kind: "dm",
    from: "pk-a",
    to: "pk-b",
    fromEd: "ab".repeat(32),
    nonce: btoa(String.fromCharCode(...new Uint8Array(24).fill(1))),
    ct: btoa(String.fromCharCode(...new Uint8Array(8).fill(2))),
    sig: "cd".repeat(64),
    ts,
  };
  assert.equal(envelopeFieldError(ok), null);
  assert.equal(envelopeFieldError({ ...ok, v: 9 }), "bad_version");
  assert.equal(
    envelopeFieldError({ ...ok, ts: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }),
    "ts_too_old"
  );
});
