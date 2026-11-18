// P1 inbox limits, rate limits, headers, outbox URL policy, and removed routes.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { checkRateLimit } from "../rate-limit.js";
import { handleInboxRoute } from "../inbox-routes.js";
import {
  AUD_A,
  PIN,
  makeDevice,
  makeEnv,
  postInbox,
  postPod,
  signEnvelope,
  testCt,
  testNonce,
  worker,
} from "./harness.js";

const MAX_ENVELOPE_BYTES = 64 * 1024;

function deleted(name) {
  return new URL(`../${name}`, import.meta.url);
}

test("P1-3 WebAuthn routes are gone and responses carry the tightened headers", async () => {
  for (const name of ["webauthn-server.js", "unlock-token.js", "feedback-limits.js", "secret-compare.js"]) {
    assert.equal(existsSync(deleted(name)), false, name);
  }
  const podDo = readFileSync(new URL("../pod-do.js", import.meta.url), "utf8");
  assert.match(podDo, /DROP TABLE IF EXISTS civic_submissions/);
  assert.match(podDo, /DROP TABLE IF EXISTS email_proof/);
  assert.doesNotMatch(podDo, /CREATE TABLE IF NOT EXISTS civic_submissions/);
  assert.doesNotMatch(podDo, /CREATE TABLE IF NOT EXISTS email_proof/);

  const env = makeEnv();
  for (const path of ["/api/webauthn/register/challenge", "/api/webauthn/login/verify"]) {
    const res = await worker.fetch(new Request(`${AUD_A}${path}`, { method: "POST" }), env);
    assert.equal(res.status, 404, path);
    const csp = res.headers.get("Content-Security-Policy");
    assert.equal(csp.includes("jsdelivr"), false);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /script-src 'self' blob: 'wasm-unsafe-eval'/);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  }

  const owner = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });
  const civic = await postPod(env, owner, {
    verb: "PUT",
    path: "/civic/submissions/abc",
    data: { comment: "hello", claimed_email: "person@example.com" },
  });
  assert.equal(civic.status, 404);
  assert.equal(civic.body.error, "route_not_found");
  const email = await postPod(env, owner, {
    verb: "PUT",
    path: "/identity/email-proof",
    data: { claimed_email: "person@example.com" },
  });
  assert.equal(email.status, 404);
  assert.equal(email.headers.get("X-Content-Type-Options"), "nosniff");
});

function draftEnvelope(over = {}) {
  return {
    v: 1,
    alg: "x25519-xchacha20poly1305-ed25519",
    kind: "dm",
    from: "pk-stranger",
    to: "pk-owner",
    fromEd: "ab".repeat(32),
    nonce: testNonce(1),
    ct: testCt(1),
    sig: "cd".repeat(64),
    ts: new Date().toISOString(),
    ...over,
  };
}

test("P1-1 inbox rejects oversized bodies and malformed envelopes", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });

  const declared = await handleInboxRoute(
    {
      method: "POST",
      headers: new Headers({ "Content-Length": String(MAX_ENVELOPE_BYTES + 8) }),
      text: async () => {
        throw new Error("body should not be read");
      },
    },
    env,
    new URL(`${AUD_A}/api/inbox`)
  );
  assert.equal(declared.status, 413);

  const bulky = await postInbox(env, "x".repeat(MAX_ENVELOPE_BYTES + 1));
  assert.equal(bulky.status, 413);
  assert.equal(bulky.body.error, "payload_too_large");

  const cases = [
    [{ fromEd: "abcd" }, "bad_from_ed"],
    [{ sig: "abcd" }, "bad_sig"],
    [{ nonce: "bm9uY2U" }, "bad_nonce"],
    [{ v: 2 }, "bad_version"],
    [{ alg: "none" }, "bad_alg"],
    [{ kind: "post" }, "bad_kind"],
    [{ ts: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString() }, "ts_too_old"],
    [{ ts: new Date(Date.now() + 10 * 60 * 1000).toISOString() }, "ts_too_new"],
    [{ ts: undefined }, "missing_ts"],
  ];
  for (const [over, reason] of cases) {
    const res = await postInbox(env, draftEnvelope(over));
    assert.equal(res.status, 400, reason);
    assert.equal(res.body.reason, reason);
  }

  const hugeCt = await postInbox(env, draftEnvelope({ ct: "A".repeat(48 * 1024 + 1) }));
  assert.equal(hugeCt.status, 413);
});

test("P1-1 group mail requires a known group and unknown senders are capped", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  const sender = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });

  const unknown = await signEnvelope(sender, {
    v: 1,
    alg: "x25519-xchacha20poly1305-ed25519",
    kind: "group",
    from: "pk-stranger",
    nonce: testNonce(7),
    ct: testCt(7),
    groupId: "g-missing",
  });
  const rejected = await postInbox(env, unknown);
  assert.equal(rejected.status, 404);
  assert.equal(rejected.body.error, "unknown_group");

  const firstIds = [];
  for (let i = 0; i < 101; i++) {
    const envelope = await signEnvelope(sender, {
      v: 1,
      alg: "x25519-xchacha20poly1305-ed25519",
      kind: "dm",
      from: "pk-stranger",
      to: "pk-owner",
      nonce: testNonce(i + 1),
      ct: testCt(i + 1),
    });
    const stored = await postInbox(env, envelope);
    assert.equal(stored.status, 200, `message ${i}`);
    if (i === 0) firstIds.push(stored.body.thread_id, envelope.sig.slice(0, 48));
  }
  const [threadId, oldestId] = firstIds;
  const listed = await postPod(env, owner, {
    verb: "LIST",
    path: "/messages",
    data: { thread_id: threadId },
  });
  assert.equal(listed.body.rows.length, 100);
  assert.equal(listed.body.rows.some((row) => row.msg_id === oldestId), false);
});

test("P1-2 rate limits are atomic, ignore X-Forwarded-For, and age out on the cron", async () => {
  const env = makeEnv();
  const first = await checkRateLimit(env.DB, "inbox:203.0.113.8", 2, 60_000);
  const second = await checkRateLimit(env.DB, "inbox:203.0.113.8", 2, 60_000);
  const third = await checkRateLimit(env.DB, "inbox:203.0.113.8", 2, 60_000);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(third.ok, false);
  assert.equal(env.DB.rates.length, 1);
  assert.equal(env.DB.rates[0].count, 3);

  const spoofed = await worker.fetch(
    new Request(`${AUD_A}/api/inbox`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": "198.51.100.9" },
      body: "{}",
    }),
    env
  );
  assert.notEqual(spoofed.status, 429);
  assert.equal(env.DB.rates.some((row) => String(row.bucket).includes("198.51.100.9")), false);
  assert.equal(env.DB.rates.some((row) => String(row.bucket).endsWith("unknown")), false);

  await postInbox(env, draftEnvelope(), "203.0.113.50");
  assert.equal(env.DB.rates.some((row) => row.bucket === "inbox:203.0.113.50"), true);

  env.DB.rates.push({ bucket: "stale", window_start_ms: 1, count: 9 });
  env.DB.usage.push({ session_id: "pod:stale", window_start_ms: 1, write_count: 4 });
  const freshCount = env.DB.rates.filter((row) => row.bucket === "inbox:203.0.113.8").length;
  await worker.scheduled({}, env);
  assert.equal(env.DB.rates.some((row) => row.bucket === "stale"), false);
  assert.equal(env.DB.usage.some((row) => row.session_id === "pod:stale"), false);
  assert.equal(env.DB.rates.filter((row) => row.bucket === "inbox:203.0.113.8").length, freshCount);
});

test("P1-2 the write budget follows the pinned pod across sessions", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  const other = await makeDevice();
  const stranger = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });
  const usageAfterProvision = env.DB.usage.map((row) => ({ ...row }));
  const denied = await postPod(env, stranger, { verb: "LIST", path: "/devices", data: null });
  assert.equal(denied.status, 401);
  assert.deepEqual(env.DB.usage, usageAfterProvision);
  const authorized = await postPod(env, owner, {
    verb: "PUT",
    path: "/devices/authorize",
    data: { ed_pub: other.publicKeyHex, label: "laptop" },
  });
  assert.equal(authorized.status, 200);

  for (let i = 0; i < 58; i++) {
    const device = i % 2 === 0 ? other : owner;
    const res = await postPod(env, device, { verb: "LIST", path: "/devices", data: null });
    assert.equal(res.status, 200, `authorized write ${i}`);
  }
  const blocked = await postPod(env, other, { verb: "LIST", path: "/devices", data: null });
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error, "pod_write_rate_exceeded");
  assert.deepEqual(
    env.DB.usage.map((row) => row.session_id),
    [`pod:${PIN}`]
  );
});

test("P1-5 outbox delivery targets must be https contacts within the envelope cap", async () => {
  const env = makeEnv();
  const owner = await makeDevice();
  await postPod(env, owner, {
    verb: "PROVISION",
    path: "/",
    data: { handle: "pk-owner", recovery_pub: owner.publicKeyHex },
  });
  await postPod(env, owner, {
    verb: "PUT",
    path: "/contacts/pk-bob",
    data: {
      display_name: "Bob",
      pod_url: "https://bob.example",
      ed: "ab".repeat(32),
      x: "cd".repeat(32),
    },
  });

  const accepted = await postPod(env, owner, {
    verb: "PUT",
    path: "/outbox/m1",
    data: { to_pod_url: "https://bob.example/pod", envelope: { v: 1, ct: "aa" } },
  });
  assert.equal(accepted.status, 200);

  const blockedUrls = [
    "http://bob.example/pod",
    "https://localhost/pod",
    "https://127.0.0.1/pod",
    "https://10.1.2.3/pod",
    "https://192.168.1.5/pod",
    "https://172.16.0.4/pod",
    "https://[::1]/pod",
    "https://user:pass@bob.example/pod",
  ];
  for (const toPodUrl of blockedUrls) {
    const res = await postPod(env, owner, {
      verb: "PUT",
      path: `/outbox/${encodeURIComponent(toPodUrl)}`,
      data: { to_pod_url: toPodUrl, envelope: { v: 1 } },
    });
    assert.equal(res.status, 400, toPodUrl);
    assert.equal(res.body.error, "undeliverable_pod_url");
  }

  const stranger = await postPod(env, owner, {
    verb: "PUT",
    path: "/outbox/stranger",
    data: { to_pod_url: "https://evil.example", envelope: { v: 1 } },
  });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error, "peer_not_a_contact");

  const oversized = await postPod(env, owner, {
    verb: "PUT",
    path: "/outbox/big",
    data: { to_pod_url: "https://bob.example", envelope: "A".repeat(MAX_ENVELOPE_BYTES + 1) },
  });
  assert.equal(oversized.status, 413);
});
