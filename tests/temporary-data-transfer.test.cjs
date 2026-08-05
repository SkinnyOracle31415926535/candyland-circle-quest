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
