import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { handleInboxRoute, lookupOwner, recordPodOwner } from "../inbox-routes.js";

const ALICE = "pk-" + "a".repeat(16);
const BOB = "pk-" + "b".repeat(16);
const POD_A = "pod-" + "a".repeat(32);
const POD_B = "pod-" + "b".repeat(32);

function memoryDb() {
  const db = new DatabaseSync(":memory:");
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      const wrap = (args) => ({
        async run() {
          return stmt.run(...args);
        },
        async first() {
          return stmt.get(...args) ?? null;
        },
        async all() {
          return { results: stmt.all(...args) };
        },
      });
      return {
        bind(...args) {
          return wrap(args);
        },
        run: () => wrap([]).run(),
        first: () => wrap([]).first(),
        all: () => wrap([]).all(),
      };
    },
    _raw: db,
  };
}

test("inbox routing locks to the first accepted pod id", async () => {
  const env = memoryDb();
  const first = await recordPodOwner({ DB: env }, ALICE, POD_A);
  assert.equal(first.ok, true);
  const secondHandle = await recordPodOwner({ DB: env }, BOB, POD_A);
  assert.equal(secondHandle.ok, true);
  const hijack = await recordPodOwner({ DB: env }, ALICE, POD_B);
  assert.equal(hijack.ok, false);
  assert.equal(hijack.reason, "owner_pod_mismatch");
  const other = await recordPodOwner({ DB: env }, BOB, POD_B);
  assert.equal(other.ok, false);

  const alice = await lookupOwner({ DB: env }, ALICE);
  assert.equal(alice.pod_id, POD_A);
  const group = await lookupOwner({ DB: env }, null);
  assert.equal(group.pod_id, POD_A);
  // An unknown handle still resolves to the locked pod. The inbox then
  // rejects the delivery because the handle does not match.
  const unknown = await lookupOwner({ DB: env }, "pk-" + "c".repeat(16));
  assert.equal(unknown.pod_id, POD_A);
  assert.notEqual(unknown.handle, "pk-" + "c".repeat(16));
});

test("ambiguous owner rows are not delivered to the newest pod", async () => {
  const env = memoryDb();
  env._raw.exec(`
    CREATE TABLE pod_owner (
      handle TEXT PRIMARY KEY,
      pod_id TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO pod_owner (handle, pod_id, updated_at) VALUES
      ('${ALICE}', '${POD_A}', '2020-01-01T00:00:00.000Z'),
      ('${BOB}', '${POD_B}', '2026-01-01T00:00:00.000Z');
  `);
  assert.equal(await lookupOwner({ DB: env }, null), null);
  assert.equal(await lookupOwner({ DB: env }, BOB), null);
  const recorded = await recordPodOwner({ DB: env }, BOB, POD_B);
  assert.equal(recorded.ok, false);
  assert.equal(recorded.reason, "owner_pod_ambiguous");
});

test("inbox rejects an oversized body before signature checks", async () => {
  let called = false;
  const env = {
    DB: memoryDb(),
    POD: {
      idFromName() {
        called = true;
        return "id";
      },
      get() {
        return { fetch: async () => new Response("no") };
      },
    },
  };
  const res = await handleInboxRoute(
    new Request("https://pod.example/api/inbox", {
      method: "POST",
      body: "x".repeat(300 * 1024),
      headers: { "content-type": "application/json", "content-length": String(300 * 1024) },
    }),
    env,
    new URL("https://pod.example/api/inbox")
  );
  assert.equal(res.status, 413);
  assert.equal(called, false);
});

test("inbox rejects a short unsigned envelope", async () => {
  const res = await handleInboxRoute(
    new Request("https://pod.example/api/inbox", {
      method: "POST",
      body: JSON.stringify({ v: 1 }),
      headers: { "content-type": "application/json" },
    }),
    { DB: memoryDb(), POD: {} },
    new URL("https://pod.example/api/inbox")
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error, "invalid_envelope");
});
