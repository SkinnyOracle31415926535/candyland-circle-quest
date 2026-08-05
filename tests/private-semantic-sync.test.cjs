const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { test } = require("node:test");
const vm = require("node:vm");

const source = readFileSync(
  new URL("../private-semantic-sync.js", "file://" + __filename),
  "utf8",
);
const moduleRef = { exports: {} };
const context = vm.createContext({ module: moduleRef, TextEncoder, URL });
new vm.Script(source, { filename: "private-semantic-sync.js" }).runInContext(context);
const sync = moduleRef.exports;

function localStorageFixture(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function semanticServer() {
  const records = new Map();
  const key = (collection, recordId) => collection + "\u001f" + recordId;
  const publicRecord = (record) => record && ({
    recordId: record.recordId,
    revision: record.revision,
    value: record.value,
    updatedAt: record.updatedAt,
  });
  const fetch = async (url, options = {}) => {
    const endpoint = new URL(url, "https://private.example");
    if (options.method !== "PUT") {
      const collection = endpoint.searchParams.get("collection");
      const listed = [...records.values()].filter((item) => item.collection === collection)
        .map(({ collection: _collection, ...record }) => record);
      return response({
        version: 1,
        appId: endpoint.searchParams.get("appId"),
        collection,
        records: listed,
      });
    }
    const request = JSON.parse(options.body);
    const recordKey = key(request.collection, request.recordId);
    const current = records.get(recordKey);
    if ((request.expectedRevision === null && current)
      || (request.expectedRevision !== null && (!current || current.revision !== request.expectedRevision))) {
      return response({ error: "conflict", current: publicRecord(current) }, 409);
    }
    const record = {
      collection: request.collection,
      recordId: request.recordId,
      revision: current ? current.revision + 1 : 1,
      value: request.value,
      updatedAt: "2026-08-05T00:00:00.000Z",
    };
    records.set(recordKey, record);
    return response({ record: publicRecord(record) });
  };
  return { records, fetch, key };
}

function profile(local, applied) {
  return {
    id: "classes",
    collection: "classes",
    owns: (recordId) => /^class-[a-z]+$/.test(recordId),
    validate: (value) => value && typeof value.name === "string",
    readAll: async () => new Map(local),
    writeLocal: async (recordId, value, deleted) => {
      if (deleted) local.delete(recordId);
      else local.set(recordId, value);
    },
    applyRemote: async (recordId, payload) => {
      if (payload.deleted) local.delete(recordId);
      else local.set(recordId, payload.value);
      applied.push(recordId);
    },
  };
}

function windowFixture(appId, server, metadata) {
  const storage = localStorageFixture({
    ["__ryan_semantic_private_sync_" + appId + "_v1"]: JSON.stringify(metadata),
  });
  return {
    localStorage: storage,
    fetch: server.fetch,
    setTimeout() { return 1; },
    setInterval() { return 1; },
    addEventListener() {},
    CustomEvent: class CustomEvent {},
  };
}

test("syncs independently scoped semantic records and writes a tombstone for a removal", async () => {
  const appId = "demo";
  const server = semanticServer();
  const local = new Map([
    ["class-alice", { name: "Alice" }],
    ["class-bob", { name: "Bob" }],
  ]);
  const applied = [];
  const statuses = [];
  const windowRef = windowFixture(appId, server, { version: 1, enabled: true, records: {} });
  const classes = profile(local, applied);
  const client = sync.createSemanticSync({
    windowRef,
    appId,
    profiles: [classes],
    onStatus: (detail) => statuses.push(detail),
  });

  await client.reconcile();
  const aliceKey = server.key("classes", "class-alice");
  const bobKey = server.key("classes", "class-bob");
  assert.equal(server.records.get(aliceKey).revision, 1);
  assert.equal(server.records.get(bobKey).revision, 1);

  local.set("class-alice", { name: "Alice v2" });
  await client.reconcile();
  assert.equal(server.records.get(aliceKey).revision, 2);
  assert.equal(server.records.get(bobKey).revision, 1);

  local.delete("class-bob");
  client.noteLocal(classes, "class-bob", true);
  await client.reconcile();
  assert.equal(server.records.get(bobKey).revision, 2);
  assert.equal(JSON.stringify(server.records.get(bobKey).value), JSON.stringify(sync.semanticValue(null, true)));
  assert.equal(statuses.at(-1).state, "synced");
});

test("applies a non-conflicting remote record without replacing another local record", async () => {
  const appId = "remote-demo";
  const server = semanticServer();
  server.records.set(server.key("classes", "class-alice"), {
    collection: "classes",
    recordId: "class-alice",
    revision: 1,
    value: sync.semanticValue({ name: "Remote Alice" }, false),
    updatedAt: "2026-08-05T00:00:00.000Z",
  });
  const local = new Map([["class-bob", { name: "Local Bob" }]]);
  const applied = [];
  const windowRef = windowFixture(appId, server, { version: 1, enabled: true, records: {} });
  const classes = profile(local, applied);
  const client = sync.createSemanticSync({ windowRef, appId, profiles: [classes] });

  await client.reconcile();
  assert.deepEqual(local.get("class-alice"), { name: "Remote Alice" });
  assert.deepEqual(local.get("class-bob"), { name: "Local Bob" });
  assert.equal(server.records.get(server.key("classes", "class-bob")).revision, 1);
  assert.deepEqual(applied, ["class-alice"]);
});

test("same-record edits become visible conflicts and preserve both versions", async () => {
  const appId = "conflict-demo";
  const server = semanticServer();
  const base = sync.semanticValue({ name: "Base" }, false);
  const remote = sync.semanticValue({ name: "Remote" }, false);
  server.records.set(server.key("classes", "class-alice"), {
    collection: "classes",
    recordId: "class-alice",
    revision: 2,
    value: remote,
    updatedAt: "2026-08-05T00:00:00.000Z",
  });
  const local = new Map([["class-alice", { name: "Local" }]]);
  const applied = [];
  const statuses = [];
  const windowRef = windowFixture(appId, server, {
    version: 1,
    enabled: true,
    records: {
      ["classes\u001fclass-alice"]: {
        revision: 1,
        remoteFingerprint: JSON.stringify(base),
        localDeleted: false,
      },
    },
  });
  const classes = profile(local, applied);
  const client = sync.createSemanticSync({
    windowRef,
    appId,
    profiles: [classes],
    onStatus: (detail) => statuses.push(detail),
  });

  await client.reconcile();
  assert.deepEqual(local.get("class-alice"), { name: "Local" });
  assert.deepEqual(server.records.get(server.key("classes", "class-alice")).value, remote);
  assert.equal(applied.length, 0);
  assert.equal(statuses.at(-1).state, "conflict");
  assert.equal(statuses.at(-1).conflicts[0].recordId, "class-alice");
});

test("exports retained legacy raw-sync records without writing or enabling semantic sync", async () => {
  const appId = "candyland-circle-quest";
  const server = semanticServer();
  server.records.set(server.key("legacy-browser-storage", "candy-circle-quest-v1"), {
    collection: "legacy-browser-storage",
    recordId: "candy-circle-quest-v1",
    revision: 7,
    value: { present: true, encoding: "json", value: { classes: [] } },
    updatedAt: "2026-08-05T00:00:00.000Z",
  });
  const before = JSON.stringify([...server.records.entries()]);
  const windowRef = windowFixture(appId, server, { version: 1, enabled: false, records: {} });
  const client = sync.createSemanticSync({ windowRef, appId, profiles: [] });

  const bundle = await client.downloadLegacyRecovery();

  assert.equal(bundle.kind, "ryan_app_sync_legacy_browser_storage_recovery");
  assert.equal(bundle.app_id, appId);
  assert.equal(bundle.records.length, 1);
  assert.equal(bundle.records[0].recordId, "candy-circle-quest-v1");
  assert.equal(JSON.stringify([...server.records.entries()]), before);
  assert.equal(client.enabled, false);
});
