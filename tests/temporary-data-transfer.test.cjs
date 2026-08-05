const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(
  new URL('../temporary-data-transfer.js', `file://${__filename}`),
  'utf8',
);
const moduleRef = { exports: {} };
const context = vm.createContext({ module: moduleRef, TextEncoder });
new vm.Script(source, { filename: 'temporary-data-transfer.js' }).runInContext(context);
const transfer = moduleRef.exports;
const inRealm = (value) => {
  context.__json = JSON.stringify(value);
  return vm.runInContext('JSON.parse(__json)', context);
};

test('accepts only the matching validated versioned transfer envelope', () => {
  const adapter = {
    validate: (value) => value && value.safe === true,
    legacy: () => null,
  };
  const good = inRealm({
    kind: transfer.TRANSFER_KIND,
    version: transfer.TRANSFER_VERSION,
    app_id: 'candyland-circle-quest',
    exported_at: '2026-08-05T00:00:00.000Z',
    payload: { safe: true },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(
    transfer.importCandidate('candyland-circle-quest', adapter, good),
  )), { data: { safe: true }, label: 'Settings and data transfer' });
  assert.throws(
    () => transfer.importCandidate('color-game', adapter, good),
    /different app/,
  );
  assert.throws(
    () => transfer.importCandidate('candyland-circle-quest', adapter, inRealm({
      ...good,
      payload: { safe: false },
    })),
    /invalid data shape/,
  );
});

test('keeps legacy support behind the same validator', () => {
  const adapter = {
    validate: (value) => value && value.safe === true,
    legacy: () => ({ data: { safe: true }, label: 'legacy backup' }),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(
    transfer.importCandidate('candyland-circle-quest', adapter, inRealm({ old: 'format' })),
  )), { data: { safe: true }, label: 'legacy backup' });
});

test('turns a complete retained private raw-sync export into the matching legacy backup', () => {
  let received = null;
  const adapter = {
    validate: (value) => value && value.safe === true,
    legacy: (value) => {
      received = JSON.parse(JSON.stringify(value));
      return { data: { safe: true }, label: 'raw backup' };
    },
  };
  const recovery = inRealm({
    kind: transfer.LEGACY_SYNC_RECOVERY_KIND,
    version: 1,
    app_id: 'candyland-circle-quest',
    exported_at: '2026-08-05T00:00:00.000Z',
    records: [
      {
        recordId: 'candy-circle-quest-v1',
        revision: 4,
        updatedAt: '2026-08-05T00:00:00.000Z',
        value: { present: true, encoding: 'json', value: { classes: [] } },
      },
      {
        recordId: 'candy-circle-quest-sound-enabled',
        revision: 3,
        updatedAt: '2026-08-05T00:00:00.000Z',
        value: { present: true, encoding: 'text', value: 'on' },
      },
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(
    transfer.importCandidate('candyland-circle-quest', adapter, recovery),
  )), { data: { safe: true }, label: 'Retained legacy private-sync recovery' });
  assert.deepEqual(received.records, [
    { key: 'candy-circle-quest-v1', present: true, raw_value: '{"classes":[]}' },
    { key: 'candy-circle-quest-sound-enabled', present: true, raw_value: 'on' },
  ]);

  assert.throws(
    () => transfer.importCandidate('color-game', adapter, recovery),
    /different app/,
  );
  assert.throws(
    () => transfer.importCandidate('candyland-circle-quest', adapter, inRealm({
      ...recovery,
      records: recovery.records.slice(0, 1),
    })),
    /incomplete/,
  );
});
