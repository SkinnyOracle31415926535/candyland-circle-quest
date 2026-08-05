/*
 * Temporary, browser-local data transfer controls shared by the legacy
 * GitHub Pages release and its private ChatGPT Site replacement.
 *
 * On legacy GitHub Pages it is browser-local only. On the owner-only
 * ChatGPT Site it may use the same-origin private record store after the
 * owner explicitly enables sync for that browser. The storage adapter must
 * validate a complete payload before this UI can replace or synchronize it.
 */
(function temporaryDataTransferModule(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (!root || !root.document) return;
  root.RyanTemporaryDataTransfer = api;
  const script = root.document.currentScript;
  const appId = script && script.dataset ? script.dataset.appId : "";
  if (appId) api.install(root, appId);
}(typeof window === "undefined" ? globalThis : window, function temporaryDataTransferFactory() {
  "use strict";

  const TRANSFER_KIND = "ryan_app_settings_data_transfer";
  const TRANSFER_VERSION = 1;
  const MAX_FILE_BYTES = 16 * 1024 * 1024;
  const MAX_SYNC_RECORD_BYTES = 900 * 1024;
  const SYNC_COLLECTION = "browser-storage";
  const SYNC_META_PREFIX = "__ryan_temporary_sync_";

  const isPlainObject = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  };

  const hasExactKeys = (value, expected) => {
    if (!isPlainObject(value)) return false;
    const keys = Object.keys(value).sort();
    const sortedExpected = expected.slice().sort();
    return keys.length === sortedExpected.length
      && keys.every((key, index) => key === sortedExpected[index]);
  };

  const parseJson = (text) => {
    if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) {
      throw new Error("That transfer file is too large or unreadable.");
    }
    try {
      return JSON.parse(text);
    } catch (_error) {
      throw new Error("That file is not valid JSON.");
    }
  };

  const dateStamp = () => new Date().toISOString().slice(0, 10);

  const downloadJson = (windowRef, value, filename) => {
    const blob = new windowRef.Blob([JSON.stringify(value, null, 2)], {
      type: "application/json",
    });
    const url = windowRef.URL.createObjectURL(blob);
    const link = windowRef.document.createElement("a");
    link.href = url;
    link.download = filename;
    windowRef.document.body.appendChild(link);
    link.click();
    link.remove();
    windowRef.setTimeout(() => windowRef.URL.revokeObjectURL(url), 1000);
  };

  const rawRecordMap = (value, appId, kind, expectedKeys) => {
    if (!hasExactKeys(value, ["app_id", "exported_at", "kind", "records", "version"])
      || value.app_id !== appId || value.kind !== kind || value.version !== 1
      || !Array.isArray(value.records)) return null;
    const records = new Map();
    for (const item of value.records) {
      if (!hasExactKeys(item, ["key", "present", "raw_value"])
        || typeof item.key !== "string" || typeof item.present !== "boolean"
        || (item.raw_value !== null && typeof item.raw_value !== "string")
        || item.present !== (item.raw_value !== null) || !expectedKeys.includes(item.key)
        || records.has(item.key)) return null;
      records.set(item.key, item.raw_value);
    }
    return expectedKeys.every((key) => records.has(key)) ? records : null;
  };

  const parseRawJson = (raw) => {
    if (raw === null) return null;
    return parseJson(raw);
  };

  const byteLength = (value) => new TextEncoder().encode(value).byteLength;

  const syncMetadataKey = (appId) => `${SYNC_META_PREFIX}${appId}_v1`;

  const safeJsonValue = (value, depth = 0) => {
    if (depth > 48 || value === null) return depth <= 48;
    if (typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) {
      return value.length <= 20000 && value.every((item) => safeJsonValue(item, depth + 1));
    }
    if (!isPlainObject(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= 20000 && entries.every(([key, item]) => (
      key.length <= 240 && key !== "__proto__" && key !== "constructor"
      && key !== "prototype" && safeJsonValue(item, depth + 1)
    ));
  };

  const encodeSyncRaw = (raw) => {
    if (raw === null) return { present: false, encoding: "text", value: null };
    try {
      const parsed = JSON.parse(raw);
      if (safeJsonValue(parsed)) return { present: true, encoding: "json", value: parsed };
    } catch (_error) {
      // Non-JSON app preferences (such as "on") remain exact text records.
    }
    return { present: true, encoding: "text", value: raw };
  };

  const validSyncValue = (value) => {
    if (!hasExactKeys(value, ["encoding", "present", "value"])
      || typeof value.present !== "boolean"
      || !["json", "text"].includes(value.encoding)) return false;
    if (!value.present) return value.encoding === "text" && value.value === null;
    if (value.encoding === "text") {
      return typeof value.value === "string" && byteLength(value.value) <= MAX_SYNC_RECORD_BYTES;
    }
    if (!safeJsonValue(value.value)) return false;
    try {
      return byteLength(JSON.stringify(value.value)) <= MAX_SYNC_RECORD_BYTES;
    } catch (_error) {
      return false;
    }
  };

  const decodeSyncValue = (value) => {
    if (!validSyncValue(value)) throw new Error("A synchronized record has an invalid schema.");
    if (!value.present) return null;
    return value.encoding === "json" ? JSON.stringify(value.value) : value.value;
  };

  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  function candyAdapter(windowRef) {
    const store = windowRef.CandylandStorage;
    if (!store) throw new Error("Candyland storage is unavailable on this page.");
    return {
      name: "Candyland Circle Quest",
      read: () => store.transferSnapshot(),
      validate: (data) => store.validateTransferSnapshot(data),
      apply: (data) => store.applyTransferSnapshot(data),
      rawBackup: () => store.rawBackup(),
      legacy: (value) => {
        if (store.validateState(value)) {
          const current = store.transferSnapshot();
          return {
            data: { state: store.canonicalState(value), sound: current.sound },
            label: "Candyland legacy backup",
          };
        }
        const records = rawRecordMap(
          value,
          "candyland-circle-quest",
          "candyland_circle_quest_browser_local_raw_backup",
          ["candy-circle-quest-v1", "candy-circle-quest-sound-enabled"],
        );
        if (!records) return null;
        const state = parseRawJson(records.get("candy-circle-quest-v1"));
        const soundRaw = records.get("candy-circle-quest-sound-enabled");
        const candidate = {
          state: state === null ? null : store.canonicalState(state),
          sound: soundRaw === null ? null : { version: 1, enabled: soundRaw === "on" },
        };
        return store.validateTransferSnapshot(candidate)
          ? { data: candidate, label: "Candyland raw backup" }
          : null;
      },
      preview: (data) => {
        const state = data.state;
        const classes = state ? state.classes.length : 0;
        const athletes = state
          ? state.classes.reduce((total, group) => total + group.athletes.length, 0)
          : 0;
        return [
          ["classes", classes],
          ["athletes", athletes],
          ["saved turns", state ? state.history.length : 0],
          ["sound preference", data.sound ? 1 : 0],
        ];
      },
    };
  }

  function colorAdapter(windowRef) {
    const store = windowRef.ColorGameStorage;
    if (!store) throw new Error("Color Game storage is unavailable on this page.");
    return {
      name: "Color Game",
      read: () => store.transferSnapshot(),
      validate: (data) => store.validateTransferSnapshot(data),
      apply: (data) => store.applyTransferSnapshot(data),
      rawBackup: () => store.rawBackup(),
      legacy: (value) => {
        const records = rawRecordMap(
          value,
          "color-game",
          "color_game_browser_local_raw_backup",
          [
            "colorPositionColors",
            "colorPositionPositions",
            "colorPositionHiddenColors",
            "colorPositionColorPercentages",
            "colorPositionNamedLists",
            "colorPositionScores",
            "colorPositionSound",
          ],
        );
        if (!records) return null;
        const colors = records.get("colorPositionColors");
        const positions = records.get("colorPositionPositions");
        const hidden = records.get("colorPositionHiddenColors");
        const percentages = records.get("colorPositionColorPercentages");
        const lists = records.get("colorPositionNamedLists");
        const scores = records.get("colorPositionScores");
        const sound = records.get("colorPositionSound");
        const candidate = {
          configuration: [colors, positions, hidden, percentages].every((item) => item === null)
            ? null
            : {
              version: 1,
              colorsText: colors,
              positionsText: positions,
              hiddenColors: hidden === null ? [] : parseRawJson(hidden),
              colorPercentages: percentages === null ? {} : parseRawJson(percentages),
            },
          named_lists: lists === null ? {} : parseRawJson(lists),
          scoreboard: scores === null ? null : { version: 1, players: parseRawJson(scores) },
          sound: sound === null ? null : { version: 1, enabled: sound === "on" },
        };
        return store.validateTransferSnapshot(candidate)
          ? { data: candidate, label: "Color Game raw backup" }
          : null;
      },
      preview: (data) => {
        const configuration = data.configuration;
        const lines = (value) => value
          ? value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean).length
          : 0;
        return [
          ["custom colors", configuration ? lines(configuration.colorsText) : 0],
          ["positions", configuration ? lines(configuration.positionsText) : 0],
          ["saved lists", Object.keys(data.named_lists).length],
          ["scoreboard players", data.scoreboard ? data.scoreboard.players.length : 0],
          ["sound preference", data.sound ? 1 : 0],
        ];
      },
    };
  }

  function scavengerAdapter(windowRef) {
    const store = windowRef.ScavengerStore;
    if (!store) throw new Error("Scavenger Hunt storage is unavailable on this page.");
    return {
      name: "Gymnastics Scavenger Hunt",
      read: () => store.transferSnapshot(),
      validate: (data) => store.validateTransferSnapshot(data),
      apply: (data) => store.applyTransferSnapshot(data),
      rawBackup: () => store.rawBackup(),
      legacy: (value) => {
        if (store.isAppState(value)) {
          return { data: { state: value }, label: "Scavenger Hunt legacy backup" };
        }
        const records = rawRecordMap(
          value,
          "scavenger-hunt",
          "scavenger_hunt_browser_local_raw_backup",
          ["star-search-offline-v1"],
        );
        if (!records) return null;
        const state = parseRawJson(records.get("star-search-offline-v1"));
        const candidate = { state };
        return store.validateTransferSnapshot(candidate)
          ? { data: candidate, label: "Scavenger Hunt raw backup" }
          : null;
      },
      preview: (data) => {
        const state = data.state;
        const classes = state ? state.classes : [];
        const athletes = classes.reduce((total, group) => total + group.athletes.length, 0);
        const hunts = classes.reduce((total, group) => total + group.events.reduce(
          (eventTotal, event) => eventTotal + event.hunts.length,
          0,
        ), 0);
        return [
          ["classes", classes.length],
          ["athletes", athletes],
          ["hunts", hunts],
          ["lesson templates", state ? state.lessonTemplates.length : 0],
        ];
      },
    };
  }

  const adapterFor = (windowRef, appId) => {
    if (appId === "candyland-circle-quest") return candyAdapter(windowRef);
    if (appId === "color-game") return colorAdapter(windowRef);
    if (appId === "scavenger-hunt") return scavengerAdapter(windowRef);
    throw new Error("This app does not have a temporary transfer adapter.");
  };

  const envelopeFor = (appId, adapter) => {
    const payload = adapter.read();
    if (!adapter.validate(payload)) {
      throw new Error("This browser’s data needs a raw backup and review before transfer.");
    }
    return {
      kind: TRANSFER_KIND,
      version: TRANSFER_VERSION,
      app_id: appId,
      exported_at: new Date().toISOString(),
      payload,
    };
  };

  const importCandidate = (appId, adapter, parsed) => {
    if (hasExactKeys(parsed, ["app_id", "exported_at", "kind", "payload", "version"])) {
      if (parsed.kind !== TRANSFER_KIND) throw new Error("That is not a settings and data transfer file.");
      if (parsed.version !== TRANSFER_VERSION) throw new Error("That transfer file uses an unsupported version.");
      if (parsed.app_id !== appId) throw new Error("That transfer file belongs to a different app.");
      if (!adapter.validate(parsed.payload)) throw new Error("That transfer file has an invalid data shape.");
      return { data: parsed.payload, label: "Settings and data transfer" };
    }
    const legacy = adapter.legacy(parsed);
    if (!legacy || !adapter.validate(legacy.data)) {
      throw new Error("That file is not a valid backup for this app.");
    }
    return legacy;
  };

  const statusText = (panel, message, isError) => {
    const node = panel.querySelector("[data-transfer-status]");
    node.textContent = message;
    node.dataset.error = isError ? "true" : "false";
  };

  const renderPreview = (panel, adapter, candidate) => {
    const list = panel.querySelector("[data-transfer-preview]");
    list.replaceChildren();
    adapter.preview(candidate.data).forEach(([label, count]) => {
      const row = panel.ownerDocument.createElement("li");
      const key = panel.ownerDocument.createElement("span");
      const value = panel.ownerDocument.createElement("strong");
      key.textContent = label;
      value.textContent = String(count);
      row.append(key, value);
      list.append(row);
    });
    panel.querySelector("[data-transfer-source]").textContent = candidate.label;
  };

  const rawSnapshotFor = (adapter) => {
    const backup = adapter.rawBackup();
    if (!isPlainObject(backup) || typeof backup.kind !== "string" || !Array.isArray(backup.records)) {
      throw new Error("This app could not make an exact local data snapshot.");
    }
    const records = new Map();
    for (const record of backup.records) {
      if (!hasExactKeys(record, ["key", "present", "raw_value"])
        || typeof record.key !== "string" || !record.key
        || typeof record.present !== "boolean"
        || (record.raw_value !== null && typeof record.raw_value !== "string")
        || record.present !== (record.raw_value !== null)
        || records.has(record.key)) {
        throw new Error("This app could not make a safe local data snapshot.");
      }
      records.set(record.key, record.raw_value);
    }
    if (!records.size) throw new Error("This app has no configured records to synchronize.");
    return { kind: backup.kind, keys: Array.from(records.keys()), records };
  };

  const semanticDataFromRaw = (appId, adapter, snapshot) => {
    const candidate = adapter.legacy({
      version: 1,
      kind: snapshot.kind,
      app_id: appId,
      exported_at: new Date().toISOString(),
      records: snapshot.keys.map((key) => ({
        key,
        present: snapshot.records.get(key) !== null,
        raw_value: snapshot.records.get(key),
      })),
    });
    if (!candidate || !adapter.validate(candidate.data)) {
      throw new Error("This browser’s data must be exported and reviewed before it can synchronize.");
    }
    return candidate.data;
  };

  const snapshotsMatch = (left, right) => (
    left.keys.length === right.keys.length
    && left.keys.every((key) => right.records.has(key) && left.records.get(key) === right.records.get(key))
  );

  const privateSyncSupported = (windowRef) => {
    const location = windowRef.location;
    return !!location && location.protocol === "https:"
      && typeof location.hostname === "string" && location.hostname.endsWith(".chatgpt.site");
  };

  const readSyncState = (windowRef, appId, keys) => {
    try {
      const parsed = JSON.parse(windowRef.localStorage.getItem(syncMetadataKey(appId)) || "null");
      if (!isPlainObject(parsed) || typeof parsed.enabled !== "boolean" || !isPlainObject(parsed.records)) {
        return { enabled: false, records: Object.create(null) };
      }
      const records = Object.create(null);
      keys.forEach((key) => {
        const item = parsed.records[key];
        if (isPlainObject(item) && Number.isSafeInteger(item.revision) && item.revision > 0
          && typeof item.fingerprint === "string" && item.fingerprint.length <= MAX_SYNC_RECORD_BYTES) {
          records[key] = { revision: item.revision, fingerprint: item.fingerprint };
        }
      });
      return { enabled: parsed.enabled, records };
    } catch (_error) {
      return { enabled: false, records: Object.create(null) };
    }
  };

  const saveSyncState = (windowRef, appId, state) => {
    windowRef.localStorage.setItem(syncMetadataKey(appId), JSON.stringify(state));
  };

  const responseJson = async (response) => {
    try {
      return await response.json();
    } catch (_error) {
      return null;
    }
  };

  const normalizeRemoteRecord = (record, expectedKeys) => {
    if (!isPlainObject(record) || typeof record.recordId !== "string"
      || !expectedKeys.includes(record.recordId)
      || !Number.isSafeInteger(record.revision) || record.revision <= 0
      || !validSyncValue(record.value)) return null;
    return { recordId: record.recordId, revision: record.revision, value: record.value };
  };

  const downloadSafetyBackup = (windowRef, appId, adapter, suffix) => {
    try {
      downloadJson(windowRef, envelopeFor(appId, adapter), `${appId}-${suffix}-${dateStamp()}.json`);
    } catch (_error) {
      downloadJson(windowRef, adapter.rawBackup(), `${appId}-${suffix}-exact-raw-${dateStamp()}.json`);
    }
  };

  const runPrivateSync = async (windowRef, appId, adapter, ui, interactive, retry) => {
    if (!privateSyncSupported(windowRef)) {
      ui.setSync("Local transfer is ready. Private sync is available in this app’s ChatGPT Site.", "local");
      return;
    }

    let initial;
    try {
      initial = rawSnapshotFor(adapter);
      // Do this before any network request, so malformed local data cannot create remote writes.
      semanticDataFromRaw(appId, adapter, initial);
    } catch (error) {
      ui.setSync(error instanceof Error ? error.message : "Local data needs review before sync.", "error");
      return;
    }

    ui.setSync("Syncing safely…", "pending");
    let manifestResponse;
    try {
      manifestResponse = await windowRef.fetch(`/api/app-sync?appId=${encodeURIComponent(appId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
    } catch (_error) {
      ui.setSync("Offline. Local data is preserved and will retry later.", "offline");
      return;
    }
    const manifest = await responseJson(manifestResponse);
    if (!manifestResponse.ok || !isPlainObject(manifest) || !Array.isArray(manifest.records)) {
      ui.setSync((manifest && manifest.error) || "Private sync is unavailable. Local data is preserved.", "offline");
      return;
    }

    const remote = new Map();
    for (const record of manifest.records) {
      const normalized = normalizeRemoteRecord(record, initial.keys);
      if (!normalized || remote.has(normalized.recordId)) {
        ui.setSync("A synchronized record needs review. Local data was preserved.", "error");
        return;
      }
      remote.set(normalized.recordId, normalized);
    }

    const state = readSyncState(windowRef, appId, initial.keys);
    const conflicts = [];
    const remoteUpdates = [];
    let localUploads = 0;

    const upload = async (key, value, expectedRevision) => {
      const response = await windowRef.fetch("/api/app-sync", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          appId,
          collection: SYNC_COLLECTION,
          recordId: key,
          expectedRevision,
          value,
        }),
      });
      const body = await responseJson(response);
      if (response.ok && body && normalizeRemoteRecord(body.record, initial.keys)) {
        return { ok: true, record: normalizeRemoteRecord(body.record, initial.keys) };
      }
      if (response.status === 409 && body && normalizeRemoteRecord(body.current, initial.keys)) {
        return { ok: false, conflict: normalizeRemoteRecord(body.current, initial.keys) };
      }
      throw new Error((body && body.error) || "Private sync could not save a record.");
    };

    try {
      for (const key of initial.keys) {
        const local = encodeSyncRaw(initial.records.get(key));
        if (!validSyncValue(local)) throw new Error("A local record is too large for private sync.");
        const fingerprint = JSON.stringify(local);
        const known = state.records[key];
        const currentRemote = remote.get(key) || null;

        if (!currentRemote) {
          if (local.present) {
            const uploaded = await upload(key, local, null);
            if (uploaded.ok) {
              state.records[key] = { revision: uploaded.record.revision, fingerprint };
              localUploads += 1;
            } else {
              conflicts.push({ key, local, remote: uploaded.conflict });
            }
          } else {
            delete state.records[key];
          }
          continue;
        }

        const remoteFingerprint = JSON.stringify(currentRemote.value);
        if (!known) {
          if (!local.present) {
            remoteUpdates.push({ key, remote: currentRemote });
          } else if (fingerprint === remoteFingerprint) {
            state.records[key] = { revision: currentRemote.revision, fingerprint };
          } else {
            conflicts.push({ key, local, remote: currentRemote });
          }
          continue;
        }

        const localChanged = known.fingerprint !== fingerprint;
        const remoteChanged = known.revision !== currentRemote.revision;
        if (localChanged && remoteChanged && fingerprint !== remoteFingerprint) {
          conflicts.push({ key, local, remote: currentRemote });
        } else if (localChanged) {
          const uploaded = await upload(key, local, known.revision);
          if (uploaded.ok) {
            state.records[key] = { revision: uploaded.record.revision, fingerprint };
            localUploads += 1;
          } else {
            conflicts.push({ key, local, remote: uploaded.conflict });
          }
        } else if (remoteChanged) {
          remoteUpdates.push({ key, remote: currentRemote });
        } else {
          state.records[key] = { revision: currentRemote.revision, fingerprint };
        }
      }
    } catch (error) {
      ui.setSync(error instanceof Error ? error.message : "Private sync did not finish.", "offline");
      return;
    }

    let remoteApplied = false;
    if (!conflicts.length && remoteUpdates.length) {
      try {
        const beforeApply = rawSnapshotFor(adapter);
        if (!snapshotsMatch(initial, beforeApply)) {
          throw new Error("This browser changed while sync was running. No synchronized data was applied.");
        }
        const merged = new Map(initial.records);
        remoteUpdates.forEach(({ key, remote: item }) => merged.set(key, decodeSyncValue(item.value)));
        const semantic = semanticDataFromRaw(appId, adapter, {
          kind: initial.kind,
          keys: initial.keys,
          records: merged,
        });
        await adapter.apply(semantic);
        const afterApply = rawSnapshotFor(adapter);
        remoteUpdates.forEach(({ key, remote: item }) => {
          state.records[key] = {
            revision: item.revision,
            fingerprint: JSON.stringify(encodeSyncRaw(afterApply.records.get(key))),
          };
        });
        remoteApplied = true;
      } catch (error) {
        state.enabled = true;
        saveSyncState(windowRef, appId, state);
        ui.setSync(error instanceof Error ? error.message : "Synchronized data was not applied.", "error");
        return;
      }
    }

    state.enabled = true;
    saveSyncState(windowRef, appId, state);

    const resolveConflict = async (conflict, choice) => {
      try {
        const current = rawSnapshotFor(adapter);
        const currentValue = encodeSyncRaw(current.records.get(conflict.key));
        if (!sameValue(currentValue, conflict.local)) {
          throw new Error("This browser changed after the conflict was found. Sync again to review the latest versions.");
        }
        if (choice === "remote") {
          downloadSafetyBackup(windowRef, appId, adapter, "before-conflict");
          const merged = new Map(current.records);
          merged.set(conflict.key, decodeSyncValue(conflict.remote.value));
          const semantic = semanticDataFromRaw(appId, adapter, {
            kind: current.kind,
            keys: current.keys,
            records: merged,
          });
          await adapter.apply(semantic);
          const afterApply = rawSnapshotFor(adapter);
          const next = readSyncState(windowRef, appId, current.keys);
          next.records[conflict.key] = {
            revision: conflict.remote.revision,
            fingerprint: JSON.stringify(encodeSyncRaw(afterApply.records.get(conflict.key))),
          };
          next.enabled = true;
          saveSyncState(windowRef, appId, next);
        } else {
          const uploaded = await upload(conflict.key, currentValue, conflict.remote.revision);
          if (!uploaded.ok) throw new Error("The synchronized record changed again. Review it once more.");
          const next = readSyncState(windowRef, appId, current.keys);
          next.records[conflict.key] = {
            revision: uploaded.record.revision,
            fingerprint: JSON.stringify(currentValue),
          };
          next.enabled = true;
          saveSyncState(windowRef, appId, next);
        }
        await retry(true);
      } catch (error) {
        ui.setSync(error instanceof Error ? error.message : "Conflict resolution did not finish.", "conflict");
      }
    };

    ui.setConflicts(conflicts, resolveConflict);
    if (conflicts.length) {
      ui.setSync(`${conflicts.length} synchronized record${conflicts.length === 1 ? " needs" : "s need"} your choice. Nothing was overwritten.`, "conflict");
      return;
    }
    ui.setSync(
      remoteApplied || localUploads
        ? `Synced ${remoteUpdates.length + localUploads} record${remoteUpdates.length + localUploads === 1 ? "" : "s"} safely.`
        : "Synced. Every local record is current.",
      "synced",
    );
    if (remoteApplied) {
      windowRef.setTimeout(() => windowRef.location.reload(), interactive ? 450 : 700);
    }
  };

  const install = (windowRef, appId) => {
    const documentRef = windowRef.document;
    if (documentRef.querySelector("[data-temporary-transfer-panel]")) return;
    let adapter;
    try {
      adapter = adapterFor(windowRef, appId);
    } catch (error) {
      return;
    }

    const style = documentRef.createElement("style");
    style.textContent = [
      ".temporary-transfer-panel{position:fixed;z-index:2147483000;right:10px;bottom:10px;width:min(330px,calc(100vw - 20px));border:3px solid #101116;background:#fffdf2;color:#101116;box-shadow:5px 5px 0 rgba(0,0,0,.55);font:700 12px/1.35 Arial,sans-serif}",
      ".temporary-transfer-panel__head{padding:8px 10px;background:#0033ff;color:#fff;font:900 11px/1.15 ui-monospace,monospace;letter-spacing:.04em}",
      ".temporary-transfer-panel__body{padding:10px;display:grid;gap:8px}",
      ".temporary-transfer-panel p{margin:0;font-size:11px}",
      ".temporary-transfer-panel__actions{display:grid;grid-template-columns:1fr 1fr;gap:6px}",
      ".temporary-transfer-panel button{min-height:34px;border:2px solid #000;background:#ffe300;color:#101116;padding:5px 6px;font:900 10px/1.15 Arial,sans-serif;cursor:pointer}",
      ".temporary-transfer-panel button[data-confirm-import]{grid-column:1/-1;background:#007e80;color:#fff}",
      ".temporary-transfer-panel button:disabled{cursor:not-allowed;opacity:.55}",
      ".temporary-transfer-panel [data-transfer-status]{min-height:1.35em;color:#005f62}",
      ".temporary-transfer-panel [data-transfer-status][data-error=true]{color:#a90000}",
      ".temporary-transfer-panel__preview{margin:0;padding:0;list-style:none;display:grid;gap:3px}",
      ".temporary-transfer-panel__preview li{display:flex;justify-content:space-between;gap:8px;border-bottom:1px dotted #777;padding-bottom:2px}",
      ".temporary-transfer-panel__sync{border-top:1px solid #777;padding-top:7px;display:grid;gap:6px}",
      ".temporary-transfer-panel__sync button{background:#e9d7ff}",
      ".temporary-transfer-panel__conflict{display:grid;grid-template-columns:1fr 1fr;gap:4px;border-top:1px dotted #777;padding-top:6px}",
      ".temporary-transfer-panel__conflict strong{grid-column:1/-1;overflow-wrap:anywhere;font-size:10px}",
      ".temporary-transfer-panel__conflict button{min-height:28px;background:#ffd5d5;font-size:9px}",
      ".temporary-transfer-panel__notice{border-top:1px solid #777;padding-top:7px;color:#333}",
    ].join("");
    documentRef.head.append(style);

    const panel = documentRef.createElement("aside");
    panel.className = "temporary-transfer-panel";
    panel.dataset.temporaryTransferPanel = "true";
    panel.setAttribute("aria-label", "Temporary settings and data transfer");
    panel.innerHTML = [
      '<div class="temporary-transfer-panel__head">TEMPORARY DATA TRANSFER</div>',
      '<div class="temporary-transfer-panel__body">',
      '<p>Move settings and saved app data between the legacy page and this private site. Photos and videos are not included.</p>',
      '<div class="temporary-transfer-panel__actions">',
      '<button type="button" data-export>Export Settings &amp; Data</button>',
      '<button type="button" data-import>Import Settings &amp; Data</button>',
      '</div>',
      '<input type="file" accept="application/json,.json" data-file hidden>',
      '<p data-transfer-status aria-live="polite">No transfer file selected.</p>',
      '<section hidden data-transfer-review>',
      '<p><strong>Preview:</strong> <span data-transfer-source></span></p>',
      '<ul class="temporary-transfer-panel__preview" data-transfer-preview></ul>',
      '<p class="temporary-transfer-panel__notice">Confirming downloads a safety backup of this device first, then replaces only this app’s local data.</p>',
      '<button type="button" data-confirm-import>Confirm replacement &amp; download safety backup</button>',
      '</section>',
      '<section class="temporary-transfer-panel__sync" hidden data-transfer-sync>',
      '<p><strong>Private device sync</strong></p>',
      '<p data-sync-status aria-live="polite">Connect this browser to the private same-site sync store.</p>',
      '<button type="button" data-enable-sync>Enable private sync &amp; sync now</button>',
      '<div data-sync-conflicts></div>',
      '</section>',
      '</div>',
    ].join("");
    documentRef.body.append(panel);

    let pending = null;
    const exportButton = panel.querySelector("[data-export]");
    const importButton = panel.querySelector("[data-import]");
    const fileInput = panel.querySelector("[data-file]");
    const review = panel.querySelector("[data-transfer-review]");
    const confirmButton = panel.querySelector("[data-confirm-import]");
    const syncSection = panel.querySelector("[data-transfer-sync]");
    const syncStatus = panel.querySelector("[data-sync-status]");
    const syncButton = panel.querySelector("[data-enable-sync]");
    const syncConflicts = panel.querySelector("[data-sync-conflicts]");

    exportButton.addEventListener("click", () => {
      try {
        const envelope = envelopeFor(appId, adapter);
        downloadJson(windowRef, envelope, `${appId}-settings-data-${dateStamp()}.json`);
        statusText(panel, "Settings and data exported.", false);
      } catch (error) {
        try {
          downloadJson(windowRef, adapter.rawBackup(), `${appId}-exact-raw-backup-${dateStamp()}.json`);
          statusText(panel, "Structured export was unavailable; an exact raw backup was downloaded instead.", true);
        } catch (_backupError) {
          statusText(panel, error instanceof Error ? error.message : "Export failed.", true);
        }
      }
    });

    importButton.addEventListener("click", () => {
      pending = null;
      review.hidden = true;
      fileInput.value = "";
      fileInput.click();
    });

    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        statusText(panel, "That transfer file is too large.", true);
        return;
      }
      const reader = new windowRef.FileReader();
      reader.onerror = () => statusText(panel, "The selected file could not be read.", true);
      reader.onload = () => {
        try {
          pending = importCandidate(appId, adapter, parseJson(String(reader.result)));
          renderPreview(panel, adapter, pending);
          review.hidden = false;
          statusText(panel, "Review the affected records, then confirm replacement.", false);
        } catch (error) {
          pending = null;
          review.hidden = true;
          statusText(panel, error instanceof Error ? error.message : "Import validation failed.", true);
        }
      };
      reader.readAsText(file);
    });

    confirmButton.addEventListener("click", async () => {
      if (!pending) return;
      if (!windowRef.confirm("Replace this app’s local settings and data after downloading a safety backup?")) {
        statusText(panel, "Replacement cancelled. Nothing changed.", false);
        return;
      }
      confirmButton.disabled = true;
      exportButton.disabled = true;
      importButton.disabled = true;
      try {
        try {
          downloadJson(windowRef, envelopeFor(appId, adapter), `${appId}-before-import-${dateStamp()}.json`);
        } catch (_error) {
          downloadJson(windowRef, adapter.rawBackup(), `${appId}-before-import-exact-raw-${dateStamp()}.json`);
        }
        await adapter.apply(pending.data);
        statusText(panel, "Data replaced safely. Reloading this app now…", false);
        windowRef.setTimeout(() => windowRef.location.reload(), 350);
      } catch (error) {
        confirmButton.disabled = false;
        exportButton.disabled = false;
        importButton.disabled = false;
        statusText(panel, error instanceof Error ? error.message : "Import failed; local data was preserved.", true);
      }
    });

    if (privateSyncSupported(windowRef)) {
      syncSection.hidden = false;
      let syncing = false;
      let interval = null;
      const syncUi = {
        setSync(message, state) {
          syncStatus.textContent = message;
          syncStatus.dataset.state = state;
        },
        setConflicts(conflicts, resolve) {
          syncConflicts.replaceChildren();
          conflicts.forEach((conflict) => {
            const row = documentRef.createElement("div");
            row.className = "temporary-transfer-panel__conflict";
            const label = documentRef.createElement("strong");
            label.textContent = conflict.key;
            const keepLocal = documentRef.createElement("button");
            keepLocal.type = "button";
            keepLocal.textContent = "Keep this device";
            keepLocal.addEventListener("click", () => { void resolve(conflict, "local"); });
            const useRemote = documentRef.createElement("button");
            useRemote.type = "button";
            useRemote.textContent = "Use synchronized record";
            useRemote.addEventListener("click", () => { void resolve(conflict, "remote"); });
            row.append(label, keepLocal, useRemote);
            syncConflicts.append(row);
          });
        },
      };
      const syncNow = async (interactive) => {
        if (syncing) return;
        syncing = true;
        syncButton.disabled = true;
        try {
          await runPrivateSync(windowRef, appId, adapter, syncUi, interactive, syncNow);
        } finally {
          syncing = false;
          syncButton.disabled = false;
        }
      };
      syncButton.addEventListener("click", () => { void syncNow(true); });
      const state = readSyncState(windowRef, appId, rawSnapshotFor(adapter).keys);
      if (state.enabled) {
        void syncNow(false);
        interval = windowRef.setInterval(() => { void syncNow(false); }, 15000);
      }
      // Keeping a reference makes this timer visible to browser debugging tools;
      // it is naturally released with the page and the temporary controls.
      panel.dataset.syncInterval = interval === null ? "" : String(interval);
    }
  };

  return {
    TRANSFER_KIND,
    TRANSFER_VERSION,
    hasExactKeys,
    parseJson,
    rawRecordMap,
    importCandidate,
    envelopeFor,
    install,
    privateSyncSupported,
    rawSnapshotFor,
    semanticDataFromRaw,
  };
}));
