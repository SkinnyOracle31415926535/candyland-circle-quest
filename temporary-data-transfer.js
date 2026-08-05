/*
 * Temporary, browser-local data transfer controls shared by the legacy
 * GitHub Pages release and its private ChatGPT Site replacement.
 *
 * On legacy GitHub Pages it is browser-local only. On the owner-only
 * ChatGPT Site, private-semantic-sync.js owns record-level synchronization;
 * this module remains the temporary import/export and conflict-review UI.
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
  const MAX_LEGACY_RECORD_BYTES = 900 * 1024;
  const LEGACY_SYNC_RECOVERY_KIND = "ryan_app_sync_legacy_browser_storage_recovery";

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

  const legacyRawSpecFor = (appId) => {
    if (appId === "candyland-circle-quest") {
      return {
        kind: "candyland_circle_quest_browser_local_raw_backup",
        keys: ["candy-circle-quest-v1", "candy-circle-quest-sound-enabled"],
      };
    }
    if (appId === "color-game") {
      return {
        kind: "color_game_browser_local_raw_backup",
        keys: [
          "colorPositionColors",
          "colorPositionPositions",
          "colorPositionHiddenColors",
          "colorPositionColorPercentages",
          "colorPositionNamedLists",
          "colorPositionScores",
          "colorPositionSound",
        ],
      };
    }
    if (appId === "scavenger-hunt") {
      return {
        kind: "scavenger_hunt_browser_local_raw_backup",
        keys: ["star-search-offline-v1"],
      };
    }
    return null;
  };

  const safeLegacyJsonValue = (value, depth = 0) => {
    if (depth > 48 || value === null) return depth <= 48;
    if (typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (Array.isArray(value)) {
      return value.length <= 20000 && value.every((item) => safeLegacyJsonValue(item, depth + 1));
    }
    if (!isPlainObject(value)) return false;
    const entries = Object.entries(value);
    return entries.length <= 20000 && entries.every(([key, item]) => (
      key.length <= 240 && key !== "__proto__" && key !== "constructor"
      && key !== "prototype" && safeLegacyJsonValue(item, depth + 1)
    ));
  };

  const validLegacyRecoveryValue = (value) => {
    if (!hasExactKeys(value, ["encoding", "present", "value"])
      || typeof value.present !== "boolean"
      || (value.encoding !== "json" && value.encoding !== "text")) return false;
    if (!value.present) return value.encoding === "text" && value.value === null;
    if (value.encoding === "text") {
      return typeof value.value === "string"
        && new TextEncoder().encode(value.value).byteLength <= MAX_LEGACY_RECORD_BYTES;
    }
    if (!safeLegacyJsonValue(value.value)) return false;
    try {
      const encoded = JSON.stringify(value.value);
      return typeof encoded === "string"
        && new TextEncoder().encode(encoded).byteLength <= MAX_LEGACY_RECORD_BYTES;
    } catch (_error) {
      return false;
    }
  };

  const legacyRecoveryCandidate = (appId, adapter, value) => {
    const spec = legacyRawSpecFor(appId);
    if (!spec || !hasExactKeys(value, ["app_id", "exported_at", "kind", "records", "version"])
      || value.kind !== LEGACY_SYNC_RECOVERY_KIND || !Array.isArray(value.records)
      || typeof value.exported_at !== "string" || value.exported_at.length > 80) {
      throw new Error("That file is not a valid retained legacy sync recovery.");
    }
    if (value.version !== 1) throw new Error("That retained legacy sync recovery uses an unsupported version.");
    if (value.app_id !== appId) throw new Error("That retained legacy sync recovery belongs to a different app.");

    const records = new Map();
    for (const item of value.records) {
      if (!hasExactKeys(item, ["recordId", "revision", "updatedAt", "value"])
        || !spec.keys.includes(item.recordId) || records.has(item.recordId)
        || !Number.isSafeInteger(item.revision) || item.revision <= 0
        || typeof item.updatedAt !== "string" || !validLegacyRecoveryValue(item.value)) {
        throw new Error("That retained legacy sync recovery has invalid or incomplete records.");
      }
      let rawValue = null;
      if (item.value.present) {
        rawValue = item.value.encoding === "json"
          ? JSON.stringify(item.value.value)
          : item.value.value;
      }
      records.set(item.recordId, rawValue);
    }
    if (records.size !== spec.keys.length || !spec.keys.every((key) => records.has(key))) {
      throw new Error("That retained legacy sync recovery is incomplete and cannot safely replace this app’s data.");
    }
    const legacy = adapter.legacy({
      version: 1,
      kind: spec.kind,
      app_id: appId,
      exported_at: value.exported_at,
      records: spec.keys.map((key) => ({
        key,
        present: records.get(key) !== null,
        raw_value: records.get(key),
      })),
    });
    if (!legacy || !adapter.validate(legacy.data)) {
      throw new Error("That retained legacy sync recovery is not valid data for this app.");
    }
    return { data: legacy.data, label: "Retained legacy private-sync recovery" };
  };

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
    if (isPlainObject(parsed) && parsed.kind === LEGACY_SYNC_RECOVERY_KIND) {
      return legacyRecoveryCandidate(appId, adapter, parsed);
    }
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

  const privateSyncSupported = (windowRef) => {
    const location = windowRef.location;
    return !!location && location.protocol === "https:"
      && typeof location.hostname === "string" && location.hostname.endsWith(".chatgpt.site");
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
      '<button type="button" data-legacy-recovery>Download retained legacy sync recovery</button>',
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
    const legacyRecoveryButton = panel.querySelector("[data-legacy-recovery]");
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
      const dispatch = (name, detail) => {
        windowRef.dispatchEvent(new windowRef.CustomEvent(name, { detail }));
      };
      const renderConflicts = (conflicts) => {
        syncConflicts.replaceChildren();
        conflicts.forEach((conflict) => {
          const row = documentRef.createElement("div");
          row.className = "temporary-transfer-panel__conflict";
          const label = documentRef.createElement("strong");
          label.textContent = conflict.label || conflict.key;
          const download = documentRef.createElement("button");
          download.type = "button";
          download.textContent = "Download both";
          download.addEventListener("click", () => {
            dispatch("ryan-private-semantic-sync-download", { key: conflict.key });
          });
          const keepLocal = documentRef.createElement("button");
          keepLocal.type = "button";
          keepLocal.textContent = "Keep this device";
          keepLocal.addEventListener("click", () => {
            dispatch("ryan-private-semantic-sync-resolve", { key: conflict.key, choice: "local" });
          });
          const useRemote = documentRef.createElement("button");
          useRemote.type = "button";
          useRemote.textContent = "Use synced record";
          useRemote.addEventListener("click", () => {
            dispatch("ryan-private-semantic-sync-resolve", { key: conflict.key, choice: "remote" });
          });
          row.append(label, download, keepLocal, useRemote);
          syncConflicts.append(row);
        });
      };
      windowRef.addEventListener("ryan-private-semantic-sync-status", (event) => {
        const detail = event && event.detail;
        if (!detail || typeof detail.message !== "string") return;
        syncStatus.textContent = detail.message;
        syncStatus.dataset.state = typeof detail.state === "string" ? detail.state : "";
        renderConflicts(Array.isArray(detail.conflicts) ? detail.conflicts : []);
      });
      syncButton.addEventListener("click", () => {
        syncButton.disabled = true;
        dispatch("ryan-private-semantic-sync-request", {});
        windowRef.setTimeout(() => { syncButton.disabled = false; }, 400);
      });
      legacyRecoveryButton.addEventListener("click", () => {
        dispatch("ryan-private-semantic-sync-legacy-export", {});
      });
    }
  };

  return {
    TRANSFER_KIND,
    TRANSFER_VERSION,
    LEGACY_SYNC_RECOVERY_KIND,
    hasExactKeys,
    parseJson,
    rawRecordMap,
    importCandidate,
    legacyRecoveryCandidate,
    envelopeFor,
    install,
    privateSyncSupported,
  };
}));
