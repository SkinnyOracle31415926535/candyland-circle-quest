const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const syncSource = readFileSync(
  new URL('../candyland-sync.js', `file://${__filename}`),
  'utf8',
);
const storageSource = readFileSync(
  new URL('../candyland-storage.js', `file://${__filename}`),
  'utf8',
);
const html = readFileSync(
  new URL('../index.html', `file://${__filename}`),
  'utf8',
);

const loadPolicy = () => {
  const window = {};
  const document = {
    body: null,
    querySelector() {
      return null;
    },
  };
  new vm.Script(syncSource, { filename: 'candyland-sync.js' })
    .runInNewContext({ window, document, Number, Object });
  return window.CandylandSyncPolicy;
};

test('migration gate requires exactly zero writes, remote records, and orphaned intents', () => {
  const policy = loadPolicy();
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 0,
    orphanedCount: 0,
  }).safe, true);
  assert.equal(policy.migrationGate({
    writesPerformed: 1,
    remoteCount: 0,
    orphanedCount: 0,
  }).safe, false);
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 1,
    orphanedCount: 0,
  }).safe, false);
  assert.equal(policy.migrationGate({
    writesPerformed: 0,
    remoteCount: 0,
    orphanedCount: 1,
  }).safe, false);
  assert.equal(policy.migrationGate({}).safe, false);
});

test('static integration owns only two named storage keys and never patches or scans native storage', () => {
  assert.match(storageSource, /state: 'candy-circle-quest-v1'/);
  assert.match(storageSource, /sound: 'candy-circle-quest-sound-enabled'/);
  assert.doesNotMatch(storageSource, /Storage\.prototype|localStorage\.clear\s*\(/);
  assert.doesNotMatch(storageSource, /localStorage\.(?:key|length)\b/);
  assert.doesNotMatch(storageSource, /for\s*\([^)]*\bin\s+window\.localStorage/);
  assert.doesNotMatch(storageSource, /\btheme\b/i);
  assert.match(html, /candyland-storage\.js/);
  assert.match(html, /ryan-app-sync[^"']*\/ryan-app-sync\.js/);
  assert.match(html, /candyland-sync\.js/);
  assert.match(html, /storage\.saveState\(state\)/);
  assert.match(html, /storage\.saveSound\(soundEnabled\)/);
  assert.doesNotMatch(html, /localStorage\.(?:setItem|getItem|removeItem|clear)\s*\(/);
});

test('migration UI creates the exact raw backup before requesting the metadata preview', () => {
  const previewHandler = syncSource.match(
    /previewButton\.addEventListener\('click',[\s\S]*?\n  \}\)\);/,
  )?.[0] || '';
  assert.match(previewHandler, /store\.assertOwnedStorageValid\(\)/);
  assert.match(previewHandler, /downloadRawBackup\(\)/);
  assert.match(previewHandler, /client\.previewMigration\(\{ downloadBackup: true \}\)/);
  assert.ok(
    previewHandler.indexOf('downloadRawBackup()') <
    previewHandler.indexOf('client.previewMigration'),
  );
});
