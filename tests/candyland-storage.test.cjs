const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { TextEncoder } = require('node:util');

const source = readFileSync(
  new URL('../candyland-storage.js', `file://${__filename}`),
  'utf8',
);

class FakeStorage {
  constructor(initial = {}) {
    this.values = new Map(Object.entries(initial));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }

  snapshot() {
    return Object.fromEntries(this.values);
  }
}

class LockManager {
  constructor() {
    this.chains = new Map();
    this.calls = [];
  }

  request(name, _options, task) {
    this.calls.push(name);
    const previous = this.chains.get(name) || Promise.resolve();
    const current = previous.then(task);
    this.chains.set(name, current.catch(() => {}));
    return current;
  }
}

const athlete = (id = 'athlete-one', name = 'Avery') => ({
  id,
  name,
  firstGoal: 1,
  repeatGoal: 1,
  circleGoal: 1,
  incrementGoal: 1,
  flairCards: 0,
  spindleCards: 0,
  russianCards: 0,
  formBonus: false,
  notes: '',
  earnedCards: 0,
  circleProgress: 0,
  circleCardsEarned: 0,
});

const group = (id = 'class-one', name = 'Class One') => ({
  id,
  name,
  label: 'C1',
  rulesKind: 'circle',
  rules: [],
  athletes: [athlete()],
});

const turn = (id = 'turn-one') => ({
  id,
  timestamp: '2026-07-28T12:00:00.000Z',
  localDate: '2026-07-28',
  classId: 'class-one',
  className: 'Class One',
  athleteId: 'athlete-one',
  athleteName: 'Avery',
  circles: 2,
  cards: 2,
});

const seed = () => ({
  version: 1,
  selectedClassId: 'class-one',
  noticeHidden: false,
  history: [],
  classes: [group()],
});

function loadStorage(initial = {}, options = {}) {
  const localStorage = new FakeStorage(initial);
  const locks = new LockManager();
  const events = [];
  const crypto = options.crypto || webcrypto;
  class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  }
  const window = {
    localStorage,
    navigator: { locks },
    crypto,
    dispatchEvent(event) {
      events.push(event);
      return true;
    },
  };
  const context = vm.createContext({
    window,
    TextEncoder,
    CustomEvent,
    console,
  });
  new vm.Script(source, { filename: 'candyland-storage.js' }).runInContext(context);
  const realm = (value) => {
    context.__fixtureJson = JSON.stringify(value);
    try {
      return vm.runInContext('JSON.parse(__fixtureJson)', context);
    } finally {
      delete context.__fixtureJson;
    }
  };
  return {
    api: window.CandylandStorage,
    localStorage,
    locks,
    events,
    context,
    realm,
  };
}

const localMetadata = Object.freeze({ source: 'local', deleted: false });
const remoteMetadata = (deleted = false) =>
  Object.freeze({ source: 'remote', deleted, revision: 1 });

test('decomposes the aggregate into fixed preferences, hashed classes, hashed turns, and sound', async () => {
  const state = seed();
  state.history.push(turn());
  const environment = loadStorage({
    'candy-circle-quest-v1': JSON.stringify(state),
    'candy-circle-quest-sound-enabled': 'off',
  });
  environment.api.loadState(environment.realm(seed()));
  const adapters = environment.api.makeAdapters();

  const preferences = await adapters.preferences.readLocal();
  const classes = await adapters.classes.listLocal();
  const turns = await adapters.turns.listLocal();
  const sound = await adapters.sound.readLocal();

  assert.equal(preferences.selectedClassId, 'class-one');
  assert.equal(preferences.noticeHidden, false);
  assert.equal(classes.length, 1);
  assert.match(classes[0].recordId, /^class-[a-f0-9]{64}$/);
  assert.equal(
    classes[0].recordId,
    await environment.api.classRecordId('class-one'),
  );
  assert.equal(turns.length, 1);
  assert.match(turns[0].recordId, /^turn-[a-f0-9]{64}$/);
  assert.equal(turns[0].recordId, await environment.api.turnRecordId('turn-one'));
  assert.equal(sound.enabled, false);
  assert.ok(environment.locks.calls.every((name) => name === environment.api.aggregateLock));
});

test('raw backup captures exactly the two owned keys without scanning unrelated storage', () => {
  const rawState = JSON.stringify(seed());
  const environment = loadStorage({
    'candy-circle-quest-v1': rawState,
    'candy-circle-quest-sound-enabled': 'on',
    'another-app-secret': 'must-not-leave-this-key',
  });
  const backup = environment.api.rawBackup();

  assert.deepEqual(
    Array.from(backup.records, (record) => record.key),
    ['candy-circle-quest-v1', 'candy-circle-quest-sound-enabled'],
  );
  assert.equal(backup.records[0].raw_value, rawState);
  assert.equal(backup.records[1].raw_value, 'on');
  assert.doesNotMatch(JSON.stringify(backup), /another-app-secret|must-not-leave-this-key/);
});

test('malformed existing bytes are preserved and every migration read fails closed', async () => {
  const malformed = '{"version":1,not-json';
  const environment = loadStorage({
    'candy-circle-quest-v1': malformed,
    'candy-circle-quest-sound-enabled': 'maybe',
  });
  const displayed = environment.api.loadState(environment.realm(seed()));
  const displayedSound = environment.api.loadSound(true);

  assert.equal(displayed.selectedClassId, 'class-one');
  assert.equal(displayedSound, true);
  assert.match(environment.api.getStorageWarning(), /raw backup and review/);
  await assert.rejects(
    environment.api.saveState(environment.realm(seed())),
    /raw backup and review/,
  );
  await assert.rejects(
    environment.api.makeAdapters().preferences.readLocal(),
    /raw backup and review/,
  );
  assert.equal(environment.localStorage.getItem('candy-circle-quest-v1'), malformed);
  assert.equal(environment.localStorage.getItem('candy-circle-quest-sound-enabled'), 'maybe');
});

test('strict validators reject accessors, inherited prototypes, oversized records, and unsafe IDs', () => {
  const environment = loadStorage();
  const valid = environment.realm(group());
  environment.context.__validClass = valid;
  const nullPrototype = vm.runInContext(
    'Object.assign(Object.create(null), __validClass)',
    environment.context,
  );
  assert.equal(environment.api.validateClass(nullPrototype), true);

  const inherited = vm.runInContext(
    'Object.assign(Object.create({ inherited: true }), __validClass)',
    environment.context,
  );
  assert.equal(environment.api.validateClass(inherited), false);

  const accessor = vm.runInContext(`(() => {
    const value = { ...__validClass };
    Object.defineProperty(value, 'name', {
      enumerable: true,
      get() { throw new Error('must not execute'); },
    });
    return value;
  })()`, environment.context);
  assert.equal(environment.api.validateClass(accessor), false);

  const oversized = environment.realm({ ...group(), rules: ['x'.repeat(128 * 1024)] });
  assert.equal(environment.api.validateClass(oversized), false);
  assert.equal(
    environment.api.validateClass(environment.realm({ ...group(), id: '__proto__' })),
    false,
  );
});

test('fixed preference and sound tombstones are rejected without changing either raw value', async () => {
  const rawState = JSON.stringify(seed());
  const environment = loadStorage({
    'candy-circle-quest-v1': rawState,
    'candy-circle-quest-sound-enabled': 'on',
  });
  environment.api.loadState(environment.realm(seed()));
  const adapters = environment.api.makeAdapters();

  assert.throws(
    () => adapters.preferences.applyRemote(null, remoteMetadata(true)),
    /fixed record and cannot be deleted/,
  );
  assert.throws(
    () => adapters.sound.applyRemote(null, remoteMetadata(true)),
    /fixed record and cannot be deleted/,
  );
  assert.deepEqual(environment.localStorage.snapshot(), {
    'candy-circle-quest-v1': rawState,
    'candy-circle-quest-sound-enabled': 'on',
  });
});

test('a raw CAS race preserves the newer aggregate instead of applying stale remote data', async () => {
  const rawState = JSON.stringify(seed());
  const localStorage = new FakeStorage({ 'candy-circle-quest-v1': rawState });
  let injectRace = false;
  let raced = false;
  const delayedCrypto = {
    subtle: {
      async digest(...args) {
        if (injectRace && !raced) {
          raced = true;
          const newer = seed();
          newer.noticeHidden = true;
          localStorage.setItem('candy-circle-quest-v1', JSON.stringify(newer));
        }
        return webcrypto.subtle.digest(...args);
      },
    },
  };
  const environment = loadStorage({}, { crypto: delayedCrypto });
  environment.localStorage.values = localStorage.values;
  environment.api.loadState(environment.realm(seed()));
  const adapters = environment.api.makeAdapters();
  const recordId = await environment.api.classRecordId('class-one');
  injectRace = true;

  await assert.rejects(
    adapters.classes.applyRemote(
      recordId,
      environment.realm({ ...group(), name: 'Remote Class' }),
      remoteMetadata(false),
    ),
    /changed during an atomic update/,
  );
  assert.equal(
    JSON.parse(environment.localStorage.getItem('candy-circle-quest-v1')).noticeHidden,
    true,
  );
});

test('rapid local saves coalesce, write the latest value first, and stage one split delta', async () => {
  const environment = loadStorage();
  environment.api.loadState(environment.realm(seed()));
  const calls = [];
  environment.context.__handles = {
    preferences: { save: async (value) => calls.push(['preferences', value]) },
    classes: {
      save: async (recordId, value) => calls.push(['class-save', recordId, value]),
      remove: async (recordId) => calls.push(['class-remove', recordId]),
    },
    turns: {
      save: async (recordId, value) => calls.push(['turn-save', recordId, value]),
      remove: async (recordId) => calls.push(['turn-remove', recordId]),
    },
    sound: { save: async (value) => calls.push(['sound', value]) },
  };
  environment.api.attachHandles(
    vm.runInContext('({ ...__handles })', environment.context),
  );

  const first = seed();
  first.noticeHidden = true;
  const latest = seed();
  latest.selectedClassId = 'class-one';
  latest.classes[0].name = 'Latest Class';
  const firstSave = environment.api.saveState(environment.realm(first));
  const latestSave = environment.api.saveState(environment.realm(latest));
  await Promise.all([firstSave, latestSave]);

  const stored = JSON.parse(environment.localStorage.getItem('candy-circle-quest-v1'));
  assert.equal(stored.noticeHidden, false);
  assert.equal(stored.classes[0].name, 'Latest Class');
  assert.equal(calls.filter(([kind]) => kind === 'preferences').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'class-save').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'turn-save').length, 0);
});

test('remote apply waits for an editor, then rejects when a newer local generation wins', async () => {
  const environment = loadStorage({
    'candy-circle-quest-v1': JSON.stringify(seed()),
  });
  environment.api.loadState(environment.realm(seed()));
  const adapters = environment.api.makeAdapters();
  environment.api.setEditorState(
    'state',
    environment.realm({ active: true, dirty: true }),
  );

  let settled = false;
  const remote = adapters.preferences.applyRemote(environment.realm({
    version: 1,
    selectedClassId: 'class-one',
    noticeHidden: true,
  }), remoteMetadata(false)).finally(() => { settled = true; });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);

  const newerLocal = seed();
  newerLocal.classes[0].name = 'Newer Local Class';
  await environment.api.saveState(environment.realm(newerLocal));
  environment.api.setEditorState(
    'state',
    environment.realm({ active: false, dirty: false }),
  );

  await assert.rejects(remote, /newer local edit needs review/);
  const stored = JSON.parse(environment.localStorage.getItem('candy-circle-quest-v1'));
  assert.equal(stored.classes[0].name, 'Newer Local Class');
  assert.equal(stored.noticeHidden, false);
});

test('collection records permit scoped tombstones while preserving unrelated records', async () => {
  const state = seed();
  state.history.push(turn('turn-one'), {
    ...turn('turn-two'),
    timestamp: '2026-07-28T13:00:00.000Z',
  });
  const environment = loadStorage({
    'candy-circle-quest-v1': JSON.stringify(state),
  });
  environment.api.loadState(environment.realm(seed()));
  const adapters = environment.api.makeAdapters();
  const firstId = await environment.api.turnRecordId('turn-one');

  await adapters.turns.writeLocal(firstId, null, {
    ...localMetadata,
    deleted: true,
  });
  const stored = JSON.parse(environment.localStorage.getItem('candy-circle-quest-v1'));
  assert.deepEqual(Array.from(stored.history, (item) => item.id), ['turn-two']);
  assert.equal(stored.classes[0].name, 'Class One');
});
