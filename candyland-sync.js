(() => {
  'use strict';

  const migrationGate = (preview) => {
    if (!preview || !Number.isInteger(preview.writesPerformed) ||
        !Number.isInteger(preview.remoteCount) ||
        !Number.isInteger(preview.orphanedCount) ||
        preview.writesPerformed < 0 || preview.remoteCount < 0 ||
        preview.orphanedCount < 0) {
      return {
        safe: false,
        message: 'Migration is blocked because the preview counts are invalid.',
      };
    }
    if (preview.writesPerformed !== 0) {
      return {
        safe: false,
        message: 'Migration is blocked because the preview performed writes.',
      };
    }
    if (preview.remoteCount > 0) {
      return {
        safe: false,
        message: `Migration is blocked because ${preview.remoteCount} synchronized remote record` +
          `${preview.remoteCount === 1 ? '' : 's'} already exist.`,
      };
    }
    if (preview.orphanedCount > 0) {
      return {
        safe: false,
        message: `Migration is blocked because ${preview.orphanedCount} orphaned local sync intent` +
          `${preview.orphanedCount === 1 ? '' : 's'} need review.`,
      };
    }
    return {
      safe: true,
      message: 'Preview confirmed: 0 writes, 0 remote records, and 0 orphaned intents.',
    };
  };

  const requireSafeMigration = (preview) => {
    const gate = migrationGate(preview);
    if (!gate.safe) throw new Error(gate.message);
    return true;
  };

  window.CandylandSyncPolicy = Object.freeze({ migrationGate, requireSafeMigration });

  const store = window.CandylandStorage;
  const headerActions = document.querySelector('.header-actions');
  if (!document.body || !headerActions || !store) return;

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.className = 'candyland-sync-open';
  openButton.dataset.candylandSyncOpen = '';
  openButton.dataset.state = 'disconnected';
  openButton.textContent = 'SYNC';
  openButton.setAttribute('aria-label', 'Open Candyland sync and backup');
  headerActions.append(openButton);

  const dialog = document.createElement('dialog');
  dialog.className = 'candyland-sync-dialog';
  dialog.setAttribute('aria-labelledby', 'candyland-sync-title');
  dialog.innerHTML = `
    <div class="candyland-sync-window">
      <div class="candyland-sync-heading">
        <div>
          <p class="candyland-sync-kicker">RYAN-ONLY APP SYNC</p>
          <h2 id="candyland-sync-title">Sync & backup</h2>
        </div>
        <button type="button" class="candyland-sync-close" data-candyland-sync-close
          aria-label="Close sync and backup window">×</button>
      </div>
      <p class="candyland-sync-copy">
        Classes, individual saved turns, app preferences, and sound can sync between Ryan’s browsers.
      </p>
      <p class="candyland-sync-safety">
        Only Candyland’s two registered browser-storage keys are read. Other apps and browser
        storage are never scanned, replaced, or cleared.
      </p>
      <div class="candyland-sync-state" data-candyland-sync-state data-state="disconnected">
        <strong data-candyland-sync-state-label>Disconnected</strong>
        <span data-candyland-sync-state-message>Candyland records stay on this device.</span>
      </div>
      <p class="candyland-sync-alert" data-candyland-sync-alert role="alert" hidden></p>
      <div class="candyland-sync-actions">
        <button type="button" class="is-primary" data-candyland-sync-connect data-sync-action>
          Connect as Ryan
        </button>
        <button type="button" data-candyland-sync-now data-sync-action>Sync now</button>
        <button type="button" data-candyland-sync-backup data-sync-action>
          Download local backup
        </button>
        <button type="button" data-candyland-sync-preview data-sync-action>
          Create backup & preview
        </button>
        <button type="button" data-candyland-sync-disconnect data-sync-action>Disconnect</button>
        <button type="button" data-candyland-sync-reset data-sync-action>
          Reset device connection
        </button>
      </div>
      <section class="candyland-sync-review" data-candyland-sync-review hidden
        aria-labelledby="candyland-sync-review-title">
        <h3 id="candyland-sync-review-title">Migration preview</h3>
        <p data-candyland-sync-counts></p>
        <p class="candyland-sync-zero-write" data-candyland-sync-zero-write></p>
        <div class="candyland-sync-records" data-candyland-sync-records></div>
        <button type="button" class="is-primary" data-candyland-sync-apply
          data-sync-action disabled>Apply reviewed migration</button>
      </section>
      <section class="candyland-sync-conflicts" data-candyland-sync-conflicts hidden
        aria-labelledby="candyland-sync-conflicts-title">
        <h3 id="candyland-sync-conflicts-title">Sync conflicts</h3>
        <p>Choose each result deliberately. No choice is made automatically.</p>
        <div class="candyland-sync-conflict-list" data-candyland-sync-conflict-list></div>
      </section>
      <p class="candyland-sync-footnote">
        Names stay inside Candyland’s app-owned records and are not placed in URLs or logs.
      </p>
      <p class="candyland-sync-footnote">
        Resetting a device connection never deletes either local Candyland storage value.
      </p>
    </div>
  `;
  document.body.append(dialog);

  const closeButton = dialog.querySelector('[data-candyland-sync-close]');
  const connectButton = dialog.querySelector('[data-candyland-sync-connect]');
  const syncButton = dialog.querySelector('[data-candyland-sync-now]');
  const backupButton = dialog.querySelector('[data-candyland-sync-backup]');
  const previewButton = dialog.querySelector('[data-candyland-sync-preview]');
  const disconnectButton = dialog.querySelector('[data-candyland-sync-disconnect]');
  const resetButton = dialog.querySelector('[data-candyland-sync-reset]');
  const applyButton = dialog.querySelector('[data-candyland-sync-apply]');
  const stateBox = dialog.querySelector('[data-candyland-sync-state]');
  const stateLabel = dialog.querySelector('[data-candyland-sync-state-label]');
  const stateMessage = dialog.querySelector('[data-candyland-sync-state-message]');
  const alert = dialog.querySelector('[data-candyland-sync-alert]');
  const review = dialog.querySelector('[data-candyland-sync-review]');
  const counts = dialog.querySelector('[data-candyland-sync-counts]');
  const zeroWrite = dialog.querySelector('[data-candyland-sync-zero-write]');
  const records = dialog.querySelector('[data-candyland-sync-records]');
  const conflicts = dialog.querySelector('[data-candyland-sync-conflicts]');
  const conflictList = dialog.querySelector('[data-candyland-sync-conflict-list]');
  const actionButtons = Array.from(dialog.querySelectorAll('[data-sync-action]'));

  let client = null;
  let previewResult = null;
  let busy = false;
  let initialized = false;
  let restoreFocus = null;

  const stateLabels = {
    disconnected: 'Disconnected',
    review: 'Migration review required',
    syncing: 'Syncing',
    synced: 'Synced',
    offline: 'Offline',
    conflict: 'Conflict needs review',
  };

  const showAlert = (message = '') => {
    alert.hidden = !message;
    alert.textContent = message;
  };

  const showStorageWarning = (message = '') => {
    const current = document.querySelector('[data-candyland-storage-warning]');
    if (!message) {
      current?.remove();
      return;
    }
    const warning = current || document.createElement('p');
    warning.className = 'candyland-storage-warning';
    warning.dataset.candylandStorageWarning = '';
    warning.setAttribute('role', 'alert');
    warning.textContent = `${message} Download the exact local backup before changing this data.`;
    if (!current) document.querySelector('.shell header')?.after(warning);
    showAlert(message);
  };

  window.CandylandSync = Object.freeze({
    showStorageWarning,
    rawBackup: () => store.rawBackup(),
  });

  const setBusy = (next) => {
    busy = next;
    dialog.setAttribute('aria-busy', String(next));
    actionButtons.forEach((button) => {
      button.disabled = next || (button === applyButton && !previewResult);
    });
    if (!next) {
      applyButton.disabled = !previewResult ||
        !migrationGate(previewResult.preview).safe;
    }
  };

  const downloadJson = (payload, filename) => {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const downloadRawBackup = () => {
    const today = new Date().toISOString().slice(0, 10);
    downloadJson(
      store.rawBackup(),
      `candyland-circle-quest-browser-local-raw-backup-${today}.json`,
    );
  };

  const invalidatePreview = () => {
    previewResult = null;
    review.hidden = true;
    records.replaceChildren();
    applyButton.disabled = true;
  };

  const makeReviewRow = (item) => {
    const row = document.createElement('div');
    row.className = 'candyland-sync-record';
    const identity = document.createElement('strong');
    identity.textContent = `${item.collection} · ${item.recordId}`;
    const status = document.createElement('span');
    status.textContent = String(item.status || '').replaceAll('-', ' ');
    row.append(identity, status);
    return row;
  };

  const renderPreview = (result) => {
    previewResult = result;
    review.hidden = false;
    counts.textContent =
      `${result.preview.localCount} local · ${result.preview.remoteCount} synchronized · ` +
      `${result.preview.conflictCount} conflict${result.preview.conflictCount === 1 ? '' : 's'} · ` +
      `${result.preview.orphanedCount} orphaned`;
    const gate = migrationGate(result.preview);
    zeroWrite.textContent = gate.message;
    zeroWrite.dataset.safe = String(gate.safe);
    records.replaceChildren(...result.preview.review.map(makeReviewRow));
    if (!result.preview.review.length) {
      const empty = document.createElement('p');
      empty.textContent = 'No registered local or synchronized records were found.';
      records.append(empty);
    }
    applyButton.disabled = busy || !gate.safe;
  };

  const conflictRecordLabel = (item) => {
    const parts = String(item.recordKey || '').split('\u001f');
    return parts.length === 4 ? `${parts[2]} · ${parts[3]}` : 'Candyland record';
  };

  const resolveConflict = async (item, strategy) => {
    if (!client) return;
    setBusy(true);
    showAlert('');
    try {
      await client.resolveConflict(item.recordKey, {
        strategy,
        expectedRemoteRevision: Number.isSafeInteger(item.current?.revision)
          ? item.current.revision
          : 0,
      });
      await renderConflicts();
    } catch (error) {
      showAlert(error.message || 'That conflict could not be resolved. Local data was preserved.');
    } finally {
      setBusy(false);
    }
  };

  const makeConflictRow = (item) => {
    const row = document.createElement('div');
    row.className = 'candyland-sync-conflict';
    const identity = document.createElement('strong');
    identity.textContent = conflictRecordLabel(item);
    const reason = document.createElement('span');
    reason.textContent = `Reason: ${String(item.reason || 'record conflict').replaceAll('-', ' ')}`;
    const actions = document.createElement('div');
    actions.className = 'candyland-sync-conflict-actions';
    const localButton = document.createElement('button');
    localButton.type = 'button';
    localButton.textContent = 'Keep this device';
    localButton.addEventListener('click', () => void resolveConflict(item, 'keep-local'));
    const remoteButton = document.createElement('button');
    remoteButton.type = 'button';
    remoteButton.textContent = 'Use synchronized record';
    remoteButton.addEventListener('click', () => void resolveConflict(item, 'accept-remote'));
    actions.append(localButton, remoteButton);
    row.append(identity, reason, actions);
    return row;
  };

  const renderConflicts = async () => {
    if (!client) return;
    const items = await client.listConflicts();
    conflicts.hidden = items.length === 0;
    conflictList.replaceChildren(...items.map(makeConflictRow));
  };

  const renderState = (next) => {
    const mode = next?.mode || 'disconnected';
    openButton.dataset.state = mode;
    stateBox.dataset.state = mode;
    stateLabel.textContent = stateLabels[mode] || mode;
    stateMessage.textContent = next?.message || 'Candyland records stay on this device.';
    if (mode === 'conflict') void renderConflicts();
    else if (mode !== 'offline') showAlert('');
  };

  const runAction = async (task) => {
    if (!initialized || busy) return;
    setBusy(true);
    showAlert('');
    try {
      await task();
    } catch (error) {
      showAlert(error.message || 'The action did not finish. Local data was preserved.');
    } finally {
      setBusy(false);
    }
  };

  openButton.addEventListener('click', () => {
    restoreFocus = document.activeElement;
    if (!dialog.open) dialog.showModal();
    showStorageWarning(store.getStorageWarning());
    void renderConflicts();
  });

  closeButton.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    if (restoreFocus && typeof restoreFocus.focus === 'function') restoreFocus.focus();
    restoreFocus = null;
  });

  connectButton.addEventListener('click', () => void runAction(() => client.connect()));
  syncButton.addEventListener('click', () => void runAction(() => client.sync()));
  backupButton.addEventListener('click', () => {
    try {
      downloadRawBackup();
      showAlert('');
    } catch (error) {
      showAlert(error.message || 'The local backup could not be created.');
    }
  });
  previewButton.addEventListener('click', () => void runAction(async () => {
    store.assertOwnedStorageValid();
    downloadRawBackup();
    const result = await client.previewMigration({ downloadBackup: true });
    renderPreview(result);
  }));
  applyButton.addEventListener('click', () => void runAction(async () => {
    if (!previewResult) throw new Error('Create a fresh migration preview first.');
    requireSafeMigration(previewResult.preview);
    await client.applyMigration(previewResult.plan, {});
    invalidatePreview();
  }));
  disconnectButton.addEventListener('click', () => void runAction(async () => {
    await client.disconnect();
    invalidatePreview();
  }));
  resetButton.addEventListener('click', () => void runAction(async () => {
    await client.resetDevice();
    invalidatePreview();
  }));

  const initialize = async () => {
    if (!window.RyanAppSync || typeof window.RyanAppSync.create !== 'function') {
      throw new Error('The Ryan App Sync client did not load. Candyland data remains local.');
    }
    client = window.RyanAppSync.create({
      appId: store.appId,
      manifestVersion: 1,
      serviceOrigin: 'https://ryan-app-sync.ryan-666-mp3.chatgpt.site',
    });
    client.onStateChange(renderState);
    const adapters = store.makeAdapters();
    const preferences = await client.register(adapters.preferences);
    const classes = await client.registerCollection(adapters.classes);
    const turns = await client.registerCollection(adapters.turns);
    const sound = await client.register(adapters.sound);
    store.attachHandles({ preferences, classes, turns, sound });
    await client.finalizeRegistration();
    initialized = true;
    setBusy(false);
    showStorageWarning(store.getStorageWarning());
  };

  setBusy(true);
  void initialize().catch((error) => {
    showAlert(error.message || 'App sync could not initialize. Candyland data remains local.');
    openButton.dataset.state = 'offline';
    stateBox.dataset.state = 'offline';
    stateLabel.textContent = 'Sync unavailable';
    stateMessage.textContent = 'Candyland records remain only on this device.';
    Array.from(dialog.querySelectorAll('[data-sync-action]'))
      .forEach((button) => { button.disabled = true; });
  });
})();
