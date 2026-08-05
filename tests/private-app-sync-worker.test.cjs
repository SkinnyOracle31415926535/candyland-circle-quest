const assert = require("node:assert/strict");
const { test } = require("node:test");

require("tsx/cjs/api").register();
const { createPrivateAppSync } = require("../worker/private-app-sync.ts");

function fakeDatabase(rows) {
  const calls = { batch: 0, bind: [], writes: 0 };
  return {
    calls,
    batch: async () => { calls.batch += 1; },
    prepare: () => ({
      bind: (...args) => {
        calls.bind.push(args);
        return {
          all: async () => ({ results: rows }),
          first: async () => null,
          run: async () => {
            calls.writes += 1;
            return { meta: { changes: 0 } };
          },
        };
      },
    }),
  };
}

test("legacy browser-storage rows are owner-readable only through the recovery export and remain read-only", async () => {
  const rows = [{
    record_id: "candy-circle-quest-v1",
    revision: 5,
    payload_json: JSON.stringify({ present: true, encoding: "json", value: { classes: [] } }),
    updated_at: "2026-08-05T00:00:00.000Z",
  }];
  const before = JSON.stringify(rows);
  const database = fakeDatabase(rows);
  const handler = createPrivateAppSync("candyland-circle-quest", ["preferences", "classes", "history-turns"]);

  const unauthenticated = await handler(
    new Request("https://private.example/api/app-sync?appId=candyland-circle-quest&collection=legacy-browser-storage"),
    { DB: database },
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(database.calls.bind.length, 0);

  const recovered = await handler(
    new Request("https://private.example/api/app-sync?appId=candyland-circle-quest&collection=legacy-browser-storage", {
      headers: { "oai-authenticated-user-id": "owner-1" },
    }),
    { DB: database },
  );
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), {
    version: 1,
    appId: "candyland-circle-quest",
    collection: "legacy-browser-storage",
    records: [{
      recordId: "candy-circle-quest-v1",
      revision: 5,
      value: { present: true, encoding: "json", value: { classes: [] } },
      updatedAt: "2026-08-05T00:00:00.000Z",
    }],
  });
  assert.equal(database.calls.bind.at(-1)[2], "browser-storage");
  assert.equal(JSON.stringify(rows), before);
  assert.equal(database.calls.writes, 0);

  const rejectedWrite = await handler(
    new Request("https://private.example/api/app-sync", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        origin: "https://private.example",
        "oai-authenticated-user-id": "owner-1",
      },
      body: JSON.stringify({
        version: 1,
        appId: "candyland-circle-quest",
        collection: "legacy-browser-storage",
        recordId: "candy-circle-quest-v1",
        expectedRevision: 5,
        value: { schemaVersion: 1, deleted: false, value: { classes: [] } },
      }),
    }),
    { DB: database },
  );
  assert.equal(rejectedWrite.status, 400);
  assert.equal(database.calls.writes, 0);
  assert.equal(JSON.stringify(rows), before);
});
