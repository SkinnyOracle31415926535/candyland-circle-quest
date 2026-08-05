/*
 * Temporary owner-only semantic record sync for the private ChatGPT Site.
 * Browser-local transfer remains in temporary-data-transfer.js; this file
 * deliberately synchronizes app records such as classes and turns instead of
 * serializing localStorage keys.
 */
(function privateSemanticSyncModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (!root || !root.document || !api.privateSite(root)) return;
  const script = root.document.currentScript;
  const appId = script && script.dataset ? script.dataset.appId : "";
  if (appId) api.install(root, appId);
}(typeof window === "undefined" ? globalThis : window, function privateSemanticSyncFactory() {
  "use strict";

  const VALUE_SCHEMA_VERSION = 1;
  const METADATA_PREFIX = "__ryan_semantic_private_sync_";
  const MAX_VALUE_BYTES = 900 * 1024;
  const SEPARATOR = "\u001f";
  const LEGACY_RECOVERY_COLLECTION = "legacy-browser-storage";
  const LEGACY_RECOVERY_KIND = "ryan_app_sync_legacy_browser_storage_recovery";

  const isPlainObject = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Object.prototype.toString.call(value) === "[object Object]";
  };

  const exactKeys = (value, keys) => (
    isPlainObject(value)
    && Object.keys(value).length === keys.length
    && Object.keys(value).every((key) => keys.includes(key))
  );

  const byteLength = (value) => new TextEncoder().encode(value).byteLength;

  const safeJson = (value, depth) => {
    const nextDepth = depth || 0;
    if (nextDepth > 48 || value === null) return nextDepth <= 48;
    if (typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) {
      return value.length <= 20000 && value.every((item) => safeJson(item, nextDepth + 1));
    }
    if (!isPlainObject(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= 20000 && entries.every(([key, item]) => (
      key.length <= 240 && key !== "__proto__" && key !== "constructor"
      && key !== "prototype" && safeJson(item, nextDepth + 1)
    ));
  };

  const semanticValue = (value, deleted) => ({
    schemaVersion: VALUE_SCHEMA_VERSION,
    deleted: Boolean(deleted),
    value: deleted ? null : value,
  });

  const validSemanticValue = (value) => {
    if (!exactKeys(value, ["schemaVersion", "deleted", "value"])
      || value.schemaVersion !== VALUE_SCHEMA_VERSION
      || typeof value.deleted !== "boolean") return false;
    if (value.deleted) return value.value === null;
    if (!safeJson(value.value)) return false;
    try {
      return byteLength(JSON.stringify(value.value)) <= MAX_VALUE_BYTES;
    } catch (_error) {
      return false;
    }
  };

  // These are the exact wrappers written by the pre-semantic private-sync
  // release. They are read only so an owner can export and recover them.
  const validLegacyRawSyncValue = (value) => {
    if (!exactKeys(value, ["present", "encoding", "value"])
      || typeof value.present !== "boolean"
      || (value.encoding !== "json" && value.encoding !== "text")) return false;
    if (!value.present) return value.encoding === "text" && value.value === null;
    if (value.encoding === "text") {
      return typeof value.value === "string" && byteLength(value.value) <= MAX_VALUE_BYTES;
    }
    if (!safeJson(value.value)) return false;
    try {
      return byteLength(JSON.stringify(value.value)) <= MAX_VALUE_BYTES;
    } catch (_error) {
      return false;
    }
  };

  const fingerprint = (value) => {
    if (!validSemanticValue(value)) throw new Error("A semantic sync record is invalid.");
    return JSON.stringify(value);
  };

  const recordKey = (collection, recordId) => collection + SEPARATOR + recordId;

  const splitRecordKey = (key) => {
    const index = key.indexOf(SEPARATOR);
    return index > 0 ? [key.slice(0, index), key.slice(index + SEPARATOR.length)] : null;
  };

  const metadataKey = (appId) => METADATA_PREFIX + appId + "_v1";

  const emptyMetadata = () => ({ version: 1, enabled: false, records: Object.create(null) });

  const normalizedMetadataRecord = (value) => {
    if (!isPlainObject(value)
      || !(value.revision === null || (Number.isSafeInteger(value.revision) && value.revision > 0))
      || !(value.remoteFingerprint === null || typeof value.remoteFingerprint === "string")
      || typeof value.localDeleted !== "boolean") return null;
    return {
      revision: value.revision,
      remoteFingerprint: value.remoteFingerprint,
      localDeleted: value.localDeleted,
    };
  };

  const readMetadata = (windowRef, appId) => {
    try {
      const parsed = JSON.parse(windowRef.localStorage.getItem(metadataKey(appId)) || "null");
      if (!isPlainObject(parsed) || parsed.version !== 1 || typeof parsed.enabled !== "boolean"
        || !isPlainObject(parsed.records)) return emptyMetadata();
      const records = Object.create(null);
      Object.entries(parsed.records).forEach(([key, value]) => {
        if (key.length > 520 || key.includes("__proto__") || key.includes("constructor")) return;
        const normalized = normalizedMetadataRecord(value);
        if (normalized) records[key] = normalized;
      });
      return { version: 1, enabled: parsed.enabled, records };
    } catch (_error) {
      return emptyMetadata();
    }
  };

  const saveMetadata = (windowRef, appId, value) => {
    windowRef.localStorage.setItem(metadataKey(appId), JSON.stringify(value));
  };

  const privateSite = (windowRef) => {
    const location = windowRef.location;
    return Boolean(location) && location.protocol === "https:"
      && typeof location.hostname === "string" && location.hostname.endsWith(".chatgpt.site");
  };

  const statusEvent = (windowRef, detail) => {
    if (typeof windowRef.CustomEvent !== "function" || typeof windowRef.dispatchEvent !== "function") return;
    windowRef.dispatchEvent(new windowRef.CustomEvent("ryan-private-semantic-sync-status", { detail }));
  };

  const responseJson = async (response) => {
    try {
      return await response.json();
    } catch (_error) {
      return null;
    }
  };

  const validRecordId = (value) => (
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(value)
  );

  const normalizeRemoteRecord = (value) => {
    if (!exactKeys(value, ["recordId", "revision", "updatedAt", "value"])
      || !validRecordId(value.recordId)
      || !Number.isSafeInteger(value.revision) || value.revision <= 0
      || typeof value.updatedAt !== "string"
      || !validSemanticValue(value.value)) return null;
    return value;
  };

  const normalizeLegacyRemoteRecord = (value) => {
    if (!exactKeys(value, ["recordId", "revision", "updatedAt", "value"])
      || !validRecordId(value.recordId)
      || !Number.isSafeInteger(value.revision) || value.revision <= 0
      || typeof value.updatedAt !== "string" || value.updatedAt.length > 80
      || !validLegacyRawSyncValue(value.value)) return null;
    return value;
  };

  const downloadJson = (windowRef, value, filename) => {
    if (!windowRef.document || !windowRef.Blob || !windowRef.URL) return;
    const blob = new windowRef.Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
    const url = windowRef.URL.createObjectURL(blob);
    const link = windowRef.document.createElement("a");
    link.href = url;
    link.download = filename;
    windowRef.document.body.append(link);
    link.click();
    link.remove();
    windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 1000);
  };

  function createSemanticSync(options) {
    const windowRef = options.windowRef;
    const appId = options.appId;
    const profiles = options.profiles;
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    let metadata = readMetadata(windowRef, appId);
    const conflicts = new Map();
    let syncing = false;
    let queued = false;
    let timer = null;

    const persist = () => saveMetadata(windowRef, appId, metadata);

    const emit = (state, message) => {
      const conflictList = Array.from(conflicts.values()).map((item) => ({
        key: item.key,
        label: item.profile.collection + " / " + item.recordId,
        collection: item.profile.collection,
        recordId: item.recordId,
      }));
      statusEvent(windowRef, { state, message, conflicts: conflictList });
      if (typeof options.onStatus === "function") options.onStatus({ state, message, conflicts: conflictList });
    };

    const stateFor = (profile, id) => {
      const key = recordKey(profile.collection, id);
      const existing = metadata.records[key];
      return existing || {
        revision: null,
        remoteFingerprint: null,
        localDeleted: false,
      };
    };

    const writeState = (profile, id, value) => {
      metadata.records[recordKey(profile.collection, id)] = value;
      persist();
    };

    const removeConflict = (key) => {
      conflicts.delete(key);
    };

    const addConflict = (profile, recordId, local, remote) => {
      const key = recordKey(profile.collection, recordId);
      conflicts.set(key, {
        key,
        profile,
        recordId,
        local,
        localFingerprint: local ? fingerprint(local) : null,
        remote,
      });
      emit(
        "conflict",
        conflicts.size + " semantic record" + (conflicts.size === 1 ? " needs" : "s need")
          + " your choice. Both versions remain preserved.",
      );
    };

    const fetchCollection = async (collection) => {
      const url = "/api/app-sync?appId=" + encodeURIComponent(appId)
        + "&collection=" + encodeURIComponent(collection);
      const response = await windowRef.fetch(url, { cache: "no-store", credentials: "same-origin" });
      const body = await responseJson(response);
      if (!response.ok || !exactKeys(body, ["appId", "collection", "records", "version"])
        || body.version !== 1 || body.appId !== appId || body.collection !== collection
        || !Array.isArray(body.records)) {
        throw new Error((body && body.error) || "Private semantic sync is unavailable.");
      }
      const records = new Map();
      for (const item of body.records) {
        const record = normalizeRemoteRecord(item);
        if (!record || records.has(record.recordId)) {
          throw new Error("A synchronized semantic record needs review.");
        }
        records.set(record.recordId, record);
      }
      return records;
    };

    const put = async (profile, recordId, value, expectedRevision) => {
      const response = await windowRef.fetch("/api/app-sync", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          appId,
          collection: profile.collection,
          recordId,
          expectedRevision,
          value,
        }),
      });
      const body = await responseJson(response);
      if (response.ok && isPlainObject(body)) {
        const record = normalizeRemoteRecord(body.record);
        if (record) return { ok: true, record };
      }
      if (response.status === 409 && isPlainObject(body)) {
        const current = normalizeRemoteRecord(body.current);
        if (current) return { ok: false, current };
      }
      throw new Error((body && body.error) || "Private semantic sync could not save a record.");
    };

    const listLocal = async (profile) => {
      const entries = await profile.readAll();
      if (!entries || typeof entries.has !== "function" || typeof entries.get !== "function"
        || typeof entries.forEach !== "function" || typeof entries.keys !== "function") {
        throw new Error("This app returned an invalid semantic record list.");
      }
      entries.forEach((value, id) => {
        if (!profile.owns(id) || !profile.validate(value, id)) {
          throw new Error("This app has invalid local data. No remote write was made.");
        }
      });
      return entries;
    };

    const localValueFor = (profile, id, local, state) => {
      if (local.has(id)) return semanticValue(local.get(id), false);
      if (state.localDeleted) return semanticValue(null, true);
      return null;
    };

    const acknowledge = (profile, id, remote) => {
      writeState(profile, id, {
        revision: remote.revision,
        remoteFingerprint: fingerprint(remote.value),
        localDeleted: remote.value.deleted,
      });
      removeConflict(recordKey(profile.collection, id));
    };

    const applyRemote = async (profile, id, remote) => {
      await profile.applyRemote(id, remote.value);
      acknowledge(profile, id, remote);
    };

    const syncOne = async (profile, id, local, remote) => {
      const key = recordKey(profile.collection, id);
      if (conflicts.has(key)) return false;
      const state = stateFor(profile, id);
      const localValue = localValueFor(profile, id, local, state);
      const localFingerprint = localValue ? fingerprint(localValue) : null;

      if (!remote) {
        if (!localValue) return false;
        if (localValue.deleted && state.revision === null) {
          writeState(profile, id, {
            revision: null,
            remoteFingerprint: null,
            localDeleted: true,
          });
          return false;
        }
        if (state.revision !== null) {
          addConflict(profile, id, localValue, null);
          return false;
        }
        const uploaded = await put(profile, id, localValue, null);
        if (uploaded.ok) {
          acknowledge(profile, id, uploaded.record);
          return true;
        }
        addConflict(profile, id, localValue, uploaded.current);
        return false;
      }

      const remoteFingerprint = fingerprint(remote.value);
      if (state.revision === null) {
        if (!localValue) {
          await applyRemote(profile, id, remote);
          return true;
        }
        if (localFingerprint === remoteFingerprint) {
          acknowledge(profile, id, remote);
          return false;
        }
        addConflict(profile, id, localValue, remote);
        return false;
      }

      const localChanged = localFingerprint !== state.remoteFingerprint;
      const remoteChanged = remote.revision !== state.revision
        || remoteFingerprint !== state.remoteFingerprint;

      if (!localValue) {
        if (!localChanged) {
          if (remoteChanged) {
            await applyRemote(profile, id, remote);
            return true;
          }
          acknowledge(profile, id, remote);
          return false;
        }
        addConflict(profile, id, null, remote);
        return false;
      }

      if (localFingerprint === remoteFingerprint) {
        acknowledge(profile, id, remote);
        return false;
      }
      if (localChanged && remoteChanged) {
        addConflict(profile, id, localValue, remote);
        return false;
      }
      if (localChanged) {
        const uploaded = await put(profile, id, localValue, remote.revision);
        if (uploaded.ok) {
          acknowledge(profile, id, uploaded.record);
          return true;
        }
        addConflict(profile, id, localValue, uploaded.current);
        return false;
      }
      if (remoteChanged) {
        await applyRemote(profile, id, remote);
        return true;
      }
      acknowledge(profile, id, remote);
      return false;
    };

    const remoteCollections = () => Array.from(new Set(profiles.map((profile) => profile.collection)));

    const reconcile = async () => {
      if (!metadata.enabled || syncing) return;
      syncing = true;
      queued = false;
      emit("pending", "Syncing semantic records safely…");
      try {
        const remoteByCollection = new Map();
        for (const collection of remoteCollections()) {
          remoteByCollection.set(collection, await fetchCollection(collection));
        }
        let changed = 0;
        for (const profile of profiles) {
          const local = await listLocal(profile);
          const remote = remoteByCollection.get(profile.collection);
          const ids = new Set(local.keys());
          remote.forEach((_value, id) => {
            if (profile.owns(id)) ids.add(id);
          });
          Object.keys(metadata.records).forEach((key) => {
            const parts = splitRecordKey(key);
            if (parts && parts[0] === profile.collection && profile.owns(parts[1])) ids.add(parts[1]);
          });
          for (const id of ids) {
            if (await syncOne(profile, id, local, remote.get(id) || null)) changed += 1;
          }
        }
        if (conflicts.size) {
          emit(
            "conflict",
            conflicts.size + " semantic record" + (conflicts.size === 1 ? " needs" : "s need")
              + " your choice. Both versions remain preserved.",
          );
        } else {
          emit(
            "synced",
            changed
              ? "Synced " + changed + " semantic record" + (changed === 1 ? "" : "s") + " safely."
              : "Synced. Every semantic record is current.",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Private semantic sync is unavailable.";
        const offline = /offline|network|fetch|unavailable|sign in/i.test(message);
        emit(offline ? "offline" : "error", offline
          ? "Offline or not signed in. Local edits are preserved and will retry."
          : message);
      } finally {
        syncing = false;
        if (queued && metadata.enabled) schedule();
      }
    };

    const schedule = () => {
      if (!metadata.enabled || queued) return;
      queued = true;
      windowRef.setTimeout(() => { void reconcile(); }, 0);
    };

    const noteLocal = (profile, recordId, deleted) => {
      if (!profile || !profile.owns(recordId)) return;
      const state = stateFor(profile, recordId);
      writeState(profile, recordId, {
        revision: state.revision,
        remoteFingerprint: state.remoteFingerprint,
        localDeleted: Boolean(deleted),
      });
      if (metadata.enabled) schedule();
    };

    const localSave = async (profileId, recordId, value, deleted) => {
      const profile = profileById.get(profileId);
      if (!profile || !profile.owns(recordId)) throw new Error("This app requested an unsupported semantic record.");
      if (!deleted && !profile.validate(value, recordId)) throw new Error("This app rejected the local semantic record.");
      await profile.writeLocal(recordId, value, Boolean(deleted));
      noteLocal(profile, recordId, Boolean(deleted));
      return true;
    };

    const conflictBundle = (conflict) => ({
      kind: "ryan_app_sync_conflict_review",
      version: 1,
      app_id: appId,
      collection: conflict.profile.collection,
      record_id: conflict.recordId,
      exported_at: new Date().toISOString(),
      local: conflict.local,
      remote: conflict.remote
        ? {
          revision: conflict.remote.revision,
          updated_at: conflict.remote.updatedAt,
          value: conflict.remote.value,
        }
        : null,
    });

    const downloadConflict = (key) => {
      const conflict = conflicts.get(key);
      if (!conflict) return;
      downloadJson(
        windowRef,
        conflictBundle(conflict),
        appId + "-sync-conflict-" + conflict.profile.collection + "-" + conflict.recordId + ".json",
      );
    };

    const downloadLegacyRecovery = async () => {
      emit("pending", "Reading retained legacy raw sync records…");
      try {
        const url = "/api/app-sync?appId=" + encodeURIComponent(appId)
          + "&collection=" + encodeURIComponent(LEGACY_RECOVERY_COLLECTION);
        const response = await windowRef.fetch(url, { cache: "no-store", credentials: "same-origin" });
        const body = await responseJson(response);
        if (!response.ok || !exactKeys(body, ["appId", "collection", "records", "version"])
          || body.version !== 1 || body.appId !== appId
          || body.collection !== LEGACY_RECOVERY_COLLECTION || !Array.isArray(body.records)) {
          throw new Error((body && body.error) || "The retained legacy sync records are unavailable.");
        }
        const recordIds = new Set();
        const records = body.records.map((item) => {
          const record = normalizeLegacyRemoteRecord(item);
          if (!record || recordIds.has(record.recordId)) {
            throw new Error("A retained legacy sync record needs review before recovery.");
          }
          recordIds.add(record.recordId);
          return record;
        });
        const bundle = {
          kind: LEGACY_RECOVERY_KIND,
          version: 1,
          app_id: appId,
          exported_at: new Date().toISOString(),
          records,
        };
        downloadJson(windowRef, bundle, appId + "-legacy-private-sync-recovery.json");
        emit(
          "synced",
          records.length
            ? "Downloaded " + records.length + " retained legacy raw sync record"
              + (records.length === 1 ? ". Import it with Settings & Data to recover this browser copy." : "s. Import it with Settings & Data to recover this browser copy.")
            : "No retained legacy raw sync records were found.",
        );
        return bundle;
      } catch (error) {
        const message = error instanceof Error ? error.message : "The retained legacy sync records are unavailable.";
        const offline = /offline|network|fetch|unavailable|sign in/i.test(message);
        emit(offline ? "offline" : "error", offline
          ? "Offline or not signed in. Retained legacy records were not changed."
          : message);
        return null;
      }
    };

    const resolveConflict = async (key, choice) => {
      const conflict = conflicts.get(key);
      if (!conflict || !["local", "remote"].includes(choice)) return;
      try {
        const local = await listLocal(conflict.profile);
        const state = stateFor(conflict.profile, conflict.recordId);
        const current = localValueFor(conflict.profile, conflict.recordId, local, state);
        const currentFingerprint = current ? fingerprint(current) : null;
        if (currentFingerprint !== conflict.localFingerprint) {
          conflicts.delete(key);
          emit("pending", "This device changed after the conflict. Refreshing the latest semantic record.");
          schedule();
          return;
        }
        if (choice === "remote") {
          if (!conflict.remote) throw new Error("The remote record is no longer available for review.");
          downloadConflict(key);
          await applyRemote(conflict.profile, conflict.recordId, conflict.remote);
        } else {
          if (!current || !conflict.remote) throw new Error("The local semantic record cannot replace this remote record.");
          const uploaded = await put(conflict.profile, conflict.recordId, current, conflict.remote.revision);
          if (!uploaded.ok) {
            addConflict(conflict.profile, conflict.recordId, current, uploaded.current);
            return;
          }
          acknowledge(conflict.profile, conflict.recordId, uploaded.record);
        }
        conflicts.delete(key);
        schedule();
      } catch (error) {
        emit("conflict", error instanceof Error ? error.message : "Conflict resolution did not finish.");
      }
    };

    const enable = () => {
      metadata.enabled = true;
      persist();
      schedule();
    };

    const start = () => {
      if (metadata.enabled) {
        schedule();
        timer = windowRef.setInterval(() => { void reconcile(); }, 20000);
      } else {
        emit("local", "Sign in as the owner, then enable private semantic sync for this device.");
      }
      windowRef.addEventListener("online", () => { if (metadata.enabled) schedule(); });
    };

    return {
      enable,
      start,
      reconcile,
      localSave,
      noteLocal,
      resolveConflict,
      downloadConflict,
      downloadLegacyRecovery,
      get enabled() { return metadata.enabled; },
      get timer() { return timer; },
    };
  }

  const fixedProfile = (id, adapter, alreadyLocal) => ({
    id,
    collection: adapter.collection,
    owns: (recordId) => recordId === adapter.recordId,
    validate: adapter.validate,
    readAll: async () => {
      const value = await adapter.readLocal();
      return value === undefined || value === null
        ? new Map()
        : new Map([[adapter.recordId, value]]);
    },
    writeLocal: async (_recordId, value, deleted) => {
      if (deleted || !adapter.validate(value)) throw new Error("A fixed semantic record cannot be deleted.");
      if (!alreadyLocal) await adapter.writeLocal(value, { source: "local", deleted: false });
    },
    applyRemote: async (_recordId, payload) => {
      if (payload.deleted || !adapter.validate(payload.value)) {
        throw new Error("A synchronized fixed semantic record was rejected.");
      }
      await adapter.applyRemote(payload.value, { source: "remote", deleted: false });
    },
  });

  const listProfile = (id, adapter, alreadyLocal) => ({
    id,
    collection: adapter.collection,
    owns: (recordId) => validRecordId(recordId),
    validate: adapter.validate,
    readAll: async () => {
      const records = await adapter.listLocal();
      if (!Array.isArray(records)) throw new Error("This app returned an invalid semantic record list.");
      const result = new Map();
      records.forEach((record) => {
        if (!isPlainObject(record) || !validRecordId(record.recordId) || result.has(record.recordId)) {
          throw new Error("This app returned duplicate or invalid semantic records.");
        }
        result.set(record.recordId, record.value);
      });
      return result;
    },
    writeLocal: async (recordId, value, deleted) => {
      if (!alreadyLocal) {
        await adapter.writeLocal(
          recordId,
          deleted ? null : value,
          { source: "local", deleted: Boolean(deleted) },
        );
      }
    },
    applyRemote: async (recordId, payload) => {
      if (!payload.deleted && !adapter.validate(payload.value, recordId)) {
        throw new Error("A synchronized semantic record was rejected.");
      }
      await adapter.applyRemote(
        recordId,
        payload.deleted ? null : payload.value,
        { source: "remote", deleted: payload.deleted },
      );
    },
  });

  function installAdapterApp(windowRef, appId, store, profileDefinitions, handles) {
    if (!store || typeof store.makeAdapters !== "function" || typeof store.attachHandles !== "function") {
      throw new Error("This app's semantic storage adapters are unavailable.");
    }
    const adapters = store.makeAdapters();
    const profiles = profileDefinitions(adapters);
    const client = createSemanticSync({ windowRef, appId, profiles });
    store.attachHandles(handles(client));
    return client;
  }

  function installCandyland(windowRef) {
    const store = windowRef.CandylandStorage;
    return installAdapterApp(
      windowRef,
      "candyland-circle-quest",
      store,
      (adapters) => [
        fixedProfile("preferences", adapters.preferences, true),
        listProfile("classes", adapters.classes, true),
        listProfile("turns", adapters.turns, true),
        fixedProfile("sound", adapters.sound, true),
      ],
      (client) => ({
        preferences: { save: (value) => client.localSave("preferences", "current", value, false) },
        classes: {
          save: (recordId, value) => client.localSave("classes", recordId, value, false),
          remove: (recordId) => client.localSave("classes", recordId, null, true),
        },
        turns: {
          save: (recordId, value) => client.localSave("turns", recordId, value, false),
          remove: (recordId) => client.localSave("turns", recordId, null, true),
        },
        sound: { save: (value) => client.localSave("sound", "sound", value, false) },
      }),
    );
  }

  function installColorGame(windowRef) {
    const store = windowRef.ColorGameStorage;
    return installAdapterApp(
      windowRef,
      "color-game",
      store,
      (adapters) => [
        fixedProfile("configuration", adapters.configuration, false),
        listProfile("savedLists", adapters.savedLists, false),
        fixedProfile("scoreboard", adapters.scoreboard, false),
        fixedProfile("sound", adapters.sound, false),
      ],
      (client) => ({
        configuration: { save: (value) => client.localSave("configuration", "current", value, false) },
        savedLists: {
          save: (recordId, value) => client.localSave("savedLists", recordId, value, false),
          remove: (recordId) => client.localSave("savedLists", recordId, null, true),
        },
        scoreboard: { save: (value) => client.localSave("scoreboard", "current", value, false) },
        sound: { save: (value) => client.localSave("sound", "sound", value, false) },
      }),
    );
  }

  function installScavenger(windowRef) {
    const store = windowRef.ScavengerStore;
    if (!store) throw new Error("Scavenger Hunt semantic storage is unavailable.");
    const profiles = [
      {
        id: "preferences",
        collection: "preferences",
        owns: (recordId) => recordId === "current",
        validate: store.isPreferencesValue,
        readAll: async () => {
          const state = store.readState();
          return state ? new Map([["current", store.preferencesValue(state)]]) : new Map();
        },
        writeLocal: async () => {},
        applyRemote: async (_recordId, payload) => {
          await store.applyPreferences(payload.deleted ? null : payload.value, {
            source: "remote",
            deleted: payload.deleted,
          });
        },
      },
      {
        id: "classes",
        collection: "classes",
        owns: validRecordId,
        validate: store.isClassValue,
        readAll: async () => {
          const records = await store.listClassRecords();
          return new Map(records.map((item) => [item.recordId, item.value]));
        },
        writeLocal: async () => {},
        applyRemote: async (recordId, payload) => {
          await store.applyClassRecord(recordId, payload.deleted ? null : payload.value, {
            source: "remote",
            deleted: payload.deleted,
          });
        },
      },
      {
        id: "lessons",
        collection: "lesson-templates",
        owns: validRecordId,
        validate: store.isLessonValue,
        readAll: async () => {
          const records = await store.listLessonRecords();
          return new Map(records.map((item) => [item.recordId, item.value]));
        },
        writeLocal: async () => {},
        applyRemote: async (recordId, payload) => {
          await store.applyLessonRecord(recordId, payload.deleted ? null : payload.value, {
            source: "remote",
            deleted: payload.deleted,
          });
        },
      },
    ];
    const client = createSemanticSync({ windowRef, appId: "scavenger-hunt", profiles });
    windowRef.addEventListener(store.changeEvent, (event) => {
      const detail = event && event.detail;
      if (!detail || ["remote", "migration"].includes(detail.source)
        || typeof detail.oldRaw !== "string" && detail.oldRaw !== null
        || typeof detail.newRaw !== "string" && detail.newRaw !== null) return;
      void store.diffRecords(detail.oldRaw, detail.newRaw).then((changes) => {
        if (changes.preferencesChanged) client.noteLocal(profiles[0], "current", false);
        changes.classes.forEach((change) => client.noteLocal(profiles[1], change.recordId, change.deleted));
        changes.lessons.forEach((change) => client.noteLocal(profiles[2], change.recordId, change.deleted));
      }).catch(() => {
        statusEvent(windowRef, {
          state: "error",
          message: "Scavenger Hunt local data needs review before private semantic sync.",
          conflicts: [],
        });
      });
    });
    return client;
  }

  const install = (windowRef, appId) => {
    let client;
    try {
      if (appId === "candyland-circle-quest") client = installCandyland(windowRef);
      else if (appId === "color-game") client = installColorGame(windowRef);
      else if (appId === "scavenger-hunt") client = installScavenger(windowRef);
      else return null;
    } catch (error) {
      statusEvent(windowRef, {
        state: "error",
        message: error instanceof Error ? error.message : "Private semantic sync could not start.",
        conflicts: [],
      });
      return null;
    }
    windowRef.addEventListener("ryan-private-semantic-sync-request", () => client.enable());
    windowRef.addEventListener("ryan-private-semantic-sync-resolve", (event) => {
      const detail = event && event.detail;
      if (detail && typeof detail.key === "string") void client.resolveConflict(detail.key, detail.choice);
    });
    windowRef.addEventListener("ryan-private-semantic-sync-download", (event) => {
      const detail = event && event.detail;
      if (detail && typeof detail.key === "string") client.downloadConflict(detail.key);
    });
    windowRef.addEventListener("ryan-private-semantic-sync-legacy-export", () => {
      void client.downloadLegacyRecovery();
    });
    client.start();
    return client;
  };

  return {
    VALUE_SCHEMA_VERSION,
    semanticValue,
    validSemanticValue,
    validLegacyRawSyncValue,
    privateSite,
    createSemanticSync,
    install,
  };
}));
