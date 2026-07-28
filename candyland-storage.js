(() => {
  'use strict';

  const APP_ID = 'candyland-circle-quest';
  const SCHEMA_VERSION = 1;
  const CHANGE_EVENT = 'candyland-circle-quest:persistent-state-change';
  const AGGREGATE_LOCK = 'candyland-circle-quest:local-aggregate-v1';
  const STORAGE_KEYS = Object.freeze({
    state: 'candy-circle-quest-v1',
    sound: 'candy-circle-quest-sound-enabled',
  });
  const RAW_BACKUP_KEYS = Object.freeze([STORAGE_KEYS.state, STORAGE_KEYS.sound]);
  const MAX_RECORD_BYTES = 128 * 1024;
  const MAX_AGGREGATE_BYTES = 16 * 1024 * 1024;
  const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const mutationStates = new Map(['state', 'sound'].map((name) => [name, {
    issuedGeneration: 0,
    pending: [],
    inFlightGeneration: 0,
    draining: false,
    editorActive: false,
    editorDirty: false,
    editorWaiters: new Set(),
  }]));
  let handles = null;
  let seedState = null;
  const storageWarnings = { state: '', sound: '' };

  const stateFor = (group) => {
    const state = mutationStates.get(group);
    if (!state) throw new Error('The Candyland storage group is invalid.');
    return state;
  };

  const withAggregateLock = (task) => {
    const locks = window.navigator && window.navigator.locks;
    if (!locks || typeof locks.request !== 'function') {
      return Promise.reject(
        new Error('Shared browser locking is unavailable. Local Candyland data was not changed.')
      );
    }
    return locks.request(AGGREGATE_LOCK, { mode: 'exclusive' }, task);
  };

  const dataObjectDescriptors = (value) => {
    try {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return null;
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') return null;
        const descriptor = descriptors[key];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
      }
      return descriptors;
    } catch (_error) {
      return null;
    }
  };

  const plainObject = (value) => Boolean(dataObjectDescriptors(value));

  const safeKeys = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors ? Object.keys(descriptors) : null;
  };

  const safeEntries = (value) => {
    const descriptors = dataObjectDescriptors(value);
    return descriptors
      ? Object.keys(descriptors).map((key) => [key, descriptors[key].value])
      : null;
  };

  const exactKeys = (value, expected) => {
    const keys = safeKeys(value);
    return Boolean(keys &&
      keys.sort().join('\u001f') === expected.slice().sort().join('\u001f'));
  };

  const safeArrayValues = (value, maximum) => {
    try {
      if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
          value.length > maximum) {
        return null;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const ownKeys = Reflect.ownKeys(descriptors);
      if (ownKeys.some((key) => typeof key !== 'string') ||
          ownKeys.length !== value.length + 1 ||
          !descriptors.length || descriptors.length.value !== value.length) {
        return null;
      }
      const result = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
            descriptor.get || descriptor.set || !descriptor.enumerable) {
          return null;
        }
        result.push(descriptor.value);
      }
      return result;
    } catch (_error) {
      return null;
    }
  };

  const jsonBytes = (value) => {
    try {
      return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch (_error) {
      return Number.POSITIVE_INFINITY;
    }
  };

  const safeJsonParse = (raw, label) => {
    if (typeof raw !== 'string' ||
        new TextEncoder().encode(raw).byteLength > MAX_AGGREGATE_BYTES) {
      throw new Error(`${label} is too large and needs a raw backup and review.`);
    }
    try {
      return JSON.parse(raw);
    } catch (_error) {
      throw new Error(`${label} needs a raw backup and review before it can be changed or synchronized.`);
    }
  };

  const hasControlCharacters = (value) => /[\u0000-\u001f\u007f]/.test(value);
  const validId = (value) => (
    typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/.test(value) &&
    !RESERVED_KEYS.has(value)
  );
  const validText = (value, maximum, allowEmpty = false) => (
    typeof value === 'string' && value.length <= maximum &&
    (allowEmpty || value.length > 0) && value === value.trim() &&
    !hasControlCharacters(value)
  );
  const validNumber = (value, minimum = 0, maximum = 1_000_000) => (
    Number.isFinite(value) && value >= minimum && value <= maximum
  );

  const captureRaw = (keys) => keys.map((key) => ({
    key,
    raw: window.localStorage.getItem(key),
  }));

  const assertRawUnchanged = (snapshot, label) => {
    if (snapshot.some(({ key, raw }) => window.localStorage.getItem(key) !== raw)) {
      throw new Error(`${label} changed during an atomic update. The newer local value was preserved.`);
    }
  };

  const restoreAppliedChanges = (snapshot, changes) => {
    const originalByKey = new Map(snapshot.map(({ key, raw }) => [key, raw]));
    for (const { key, raw } of changes) {
      if (window.localStorage.getItem(key) !== raw) continue;
      const original = originalByKey.get(key);
      if (original === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, original);
    }
  };

  const compareAndSet = (snapshot, changes, label) => {
    assertRawUnchanged(snapshot, label);
    try {
      for (const { key, raw } of changes) {
        if (raw === null) window.localStorage.removeItem(key);
        else window.localStorage.setItem(key, raw);
      }
      for (const { key, raw } of changes) {
        if (window.localStorage.getItem(key) !== raw) {
          throw new Error(`${label} could not be verified after writing.`);
        }
      }
    } catch (error) {
      restoreAppliedChanges(snapshot, changes);
      throw error;
    }
  };

  const validateAthlete = (candidate) => {
    if (!exactKeys(candidate, [
      'id', 'name', 'firstGoal', 'repeatGoal', 'circleGoal', 'incrementGoal',
      'flairCards', 'spindleCards', 'russianCards', 'formBonus', 'notes',
      'earnedCards', 'circleProgress', 'circleCardsEarned',
    ])) return false;
    const value = Object.fromEntries(safeEntries(candidate));
    return validId(value.id) && validText(value.name, 80) &&
      validNumber(value.firstGoal, 0.125) && validNumber(value.repeatGoal, 0.125) &&
      validNumber(value.circleGoal, 0.125) && validNumber(value.incrementGoal, 0.125) &&
      validNumber(value.flairCards) && validNumber(value.spindleCards) &&
      validNumber(value.russianCards) && typeof value.formBonus === 'boolean' &&
      validText(value.notes, 300, true) && validNumber(value.earnedCards) &&
      validNumber(value.circleProgress) && validNumber(value.circleCardsEarned);
  };

  const canonicalAthlete = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      id: value.id,
      name: value.name,
      firstGoal: value.firstGoal,
      repeatGoal: value.repeatGoal,
      circleGoal: value.circleGoal,
      incrementGoal: value.incrementGoal,
      flairCards: value.flairCards,
      spindleCards: value.spindleCards,
      russianCards: value.russianCards,
      formBonus: value.formBonus,
      notes: value.notes,
      earnedCards: value.earnedCards,
      circleProgress: value.circleProgress,
      circleCardsEarned: value.circleCardsEarned,
    };
  };

  const validateClass = (candidate, recordId = `class-${'0'.repeat(64)}`) => {
    if (!/^class-[a-f0-9]{64}$/.test(recordId || '') ||
        !exactKeys(candidate, ['id', 'name', 'label', 'rulesKind', 'rules', 'athletes']) ||
        jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    const rules = safeArrayValues(value.rules, 32);
    const athletes = safeArrayValues(value.athletes, 250);
    if (!validId(value.id) || !validText(value.name, 80) ||
        !validText(value.label, 14, true) || !validText(value.rulesKind, 32) ||
        !rules || !athletes ||
        rules.some((rule) => !validText(rule, 800)) ||
        athletes.some((athlete) => !validateAthlete(athlete))) {
      return false;
    }
    const athleteIds = athletes.map((athlete) => Object.fromEntries(safeEntries(athlete)).id);
    return new Set(athleteIds).size === athleteIds.length;
  };

  const canonicalClass = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      id: value.id,
      name: value.name,
      label: value.label,
      rulesKind: value.rulesKind,
      rules: safeArrayValues(value.rules, 32).slice(),
      athletes: safeArrayValues(value.athletes, 250).map(canonicalAthlete),
    };
  };

  const validateTurn = (candidate, recordId = `turn-${'0'.repeat(64)}`) => {
    if (!/^turn-[a-f0-9]{64}$/.test(recordId || '') ||
        !exactKeys(candidate, [
          'id', 'timestamp', 'localDate', 'classId', 'className',
          'athleteId', 'athleteName', 'circles', 'cards',
        ]) || jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    const time = Date.parse(value.timestamp);
    return validId(value.id) && typeof value.timestamp === 'string' &&
      Number.isFinite(time) && new Date(time).toISOString() === value.timestamp &&
      typeof value.localDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.localDate) &&
      validId(value.classId) && validText(value.className, 80) &&
      validId(value.athleteId) && validText(value.athleteName, 80) &&
      validNumber(value.circles, 0, 1_000_000_000) &&
      Number.isSafeInteger(value.cards) && value.cards >= 0 && value.cards <= 1_000_000_000;
  };

  const canonicalTurn = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      id: value.id,
      timestamp: value.timestamp,
      localDate: value.localDate,
      classId: value.classId,
      className: value.className,
      athleteId: value.athleteId,
      athleteName: value.athleteName,
      circles: value.circles,
      cards: value.cards,
    };
  };

  const validatePreferences = (candidate) => {
    if (!exactKeys(candidate, ['version', 'selectedClassId', 'noticeHidden']) ||
        jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    return value.version === SCHEMA_VERSION && validId(value.selectedClassId) &&
      typeof value.noticeHidden === 'boolean';
  };

  const canonicalPreferences = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      version: SCHEMA_VERSION,
      selectedClassId: value.selectedClassId,
      noticeHidden: value.noticeHidden,
    };
  };

  const validateSound = (candidate) => {
    if (!exactKeys(candidate, ['version', 'enabled']) ||
        jsonBytes(candidate) > MAX_RECORD_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    return value.version === SCHEMA_VERSION && typeof value.enabled === 'boolean';
  };

  const canonicalSound = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return { version: SCHEMA_VERSION, enabled: value.enabled };
  };

  const validateState = (candidate) => {
    if (!exactKeys(candidate, [
      'version', 'selectedClassId', 'noticeHidden', 'history', 'classes',
    ]) || jsonBytes(candidate) > MAX_AGGREGATE_BYTES) {
      return false;
    }
    const value = Object.fromEntries(safeEntries(candidate));
    const classes = safeArrayValues(value.classes, 200);
    const history = safeArrayValues(value.history, 50_000);
    if (value.version !== SCHEMA_VERSION || !validId(value.selectedClassId) ||
        typeof value.noticeHidden !== 'boolean' || !classes || !classes.length ||
        !history || classes.some((group) => !validateClass(group)) ||
        history.some((turn) => !validateTurn(turn))) {
      return false;
    }
    const classIds = classes.map((group) => Object.fromEntries(safeEntries(group)).id);
    const athleteIds = classes.flatMap((group) => {
      const value = Object.fromEntries(safeEntries(group));
      return safeArrayValues(value.athletes, 250)
        .map((athlete) => Object.fromEntries(safeEntries(athlete)).id);
    });
    const turnIds = history.map((turn) => Object.fromEntries(safeEntries(turn)).id);
    return new Set(classIds).size === classIds.length &&
      new Set(athleteIds).size === athleteIds.length &&
      new Set(turnIds).size === turnIds.length;
  };

  const canonicalState = (candidate) => {
    const value = Object.fromEntries(safeEntries(candidate));
    return {
      version: SCHEMA_VERSION,
      selectedClassId: value.selectedClassId,
      noticeHidden: value.noticeHidden,
      history: safeArrayValues(value.history, 50_000).map(canonicalTurn),
      classes: safeArrayValues(value.classes, 200).map(canonicalClass),
    };
  };

  const readStateFromRaw = (raw) => {
    if (raw === null) return undefined;
    const parsed = safeJsonParse(raw, 'Candyland app data');
    if (!validateState(parsed)) {
      throw new Error(
        'Local Candyland app data needs a raw backup and review before it can be changed or synchronized.'
      );
    }
    return canonicalState(parsed);
  };

  const readStateUnlocked = () =>
    readStateFromRaw(window.localStorage.getItem(STORAGE_KEYS.state));

  const readSoundFromRaw = (raw) => {
    if (raw === null) return undefined;
    if (!['on', 'off'].includes(raw)) {
      throw new Error(
        'Local Candyland sound data needs a raw backup and review before it can be changed or synchronized.'
      );
    }
    return { version: SCHEMA_VERSION, enabled: raw === 'on' };
  };

  const readSoundUnlocked = () =>
    readSoundFromRaw(window.localStorage.getItem(STORAGE_KEYS.sound));

  const dispatchChange = (collection, source) => {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, {
      detail: { collection, source },
    }));
  };

  const sha256 = async (value) => {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Secure hashing is required to synchronize Candyland records.');
    }
    const digest = await window.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(value),
    );
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0')).join('');
  };

  const classRecordId = async (classId) => {
    if (!validId(classId)) throw new Error('The Candyland class ID is invalid.');
    return `class-${await sha256(classId)}`;
  };

  const turnRecordId = async (turnId) => {
    if (!validId(turnId)) throw new Error('The Candyland turn ID is invalid.');
    return `turn-${await sha256(turnId)}`;
  };

  const identifyClasses = async (classes) => {
    const records = await Promise.all(classes.map(async (group) => ({
      sourceId: group.id,
      recordId: await classRecordId(group.id),
      value: canonicalClass(group),
    })));
    if (new Set(records.map(({ recordId }) => recordId)).size !== records.length) {
      throw new Error('Local Candyland class identities collide and need review.');
    }
    return records;
  };

  const identifyTurns = async (history) => {
    const records = await Promise.all(history.map(async (turn) => ({
      sourceId: turn.id,
      recordId: await turnRecordId(turn.id),
      value: canonicalTurn(turn),
    })));
    if (new Set(records.map(({ recordId }) => recordId)).size !== records.length) {
      throw new Error('Local Candyland turn identities collide and need review.');
    }
    return records;
  };

  const preferencesFromState = (state) => ({
    version: SCHEMA_VERSION,
    selectedClassId: state.selectedClassId,
    noticeHidden: state.noticeHidden,
  });

  const localWorkPending = (state) =>
    Boolean(state.pending.length || state.inFlightGeneration);

  const assertConsistentRead = (group) => {
    const state = stateFor(group);
    if (localWorkPending(state) || state.editorActive || state.editorDirty) {
      throw new Error(`Local Candyland ${group} edits must settle before synchronization can read them.`);
    }
  };

  const wakeEditorWaiters = (state) => {
    if (state.editorActive || state.editorDirty) return;
    for (const resolve of state.editorWaiters) resolve();
    state.editorWaiters.clear();
  };

  const waitForEditorIdle = (group) => {
    const state = stateFor(group);
    if (!state.editorActive && !state.editorDirty) return Promise.resolve();
    return new Promise((resolve) => state.editorWaiters.add(resolve));
  };

  const assertRemoteWritable = (group, generation) => {
    const state = stateFor(group);
    if (state.issuedGeneration !== generation || localWorkPending(state) ||
        state.editorActive || state.editorDirty) {
      throw new Error(
        `Remote Candyland ${group} data was not applied because a newer local edit needs review.`
      );
    }
  };

  const withConsistentRead = (group, task) => withAggregateLock(() => {
    assertConsistentRead(group);
    return task();
  });

  const withRemoteWrite = async (group, task) => {
    const state = stateFor(group);
    const generation = state.issuedGeneration;
    if (localWorkPending(state)) {
      throw new Error(`Remote Candyland ${group} data was not applied because local work is pending.`);
    }
    await waitForEditorIdle(group);
    assertRemoteWritable(group, generation);
    return withAggregateLock(async () => {
      assertRemoteWritable(group, generation);
      const assertCurrent = () => assertRemoteWritable(group, generation);
      return task(assertCurrent);
    });
  };

  const enqueueLatest = (group, coalesceKey, perform) => {
    const state = stateFor(group);
    const generation = ++state.issuedGeneration;
    const promise = new Promise((resolve, reject) => {
      const pending = state.pending.find((job) => job.coalesceKey === coalesceKey);
      if (!pending) {
        state.pending.push({ coalesceKey, generation, perform, waiters: [{ resolve, reject }] });
      } else {
        pending.generation = generation;
        pending.perform = perform;
        pending.waiters.push({ resolve, reject });
      }
    });
    if (!state.draining) {
      state.draining = true;
      Promise.resolve().then(async () => {
        try {
          while (state.pending.length) {
            const job = state.pending.shift();
            state.inFlightGeneration = job.generation;
            try {
              const result = await job.perform(job.generation);
              job.waiters.forEach(({ resolve }) => resolve(result));
            } catch (error) {
              job.waiters.forEach(({ reject }) => reject(error));
            } finally {
              state.inFlightGeneration = 0;
            }
          }
        } finally {
          state.draining = false;
        }
      });
    }
    return promise;
  };

  const setEditorState = (group, update) => {
    const state = stateFor(group);
    if (!plainObject(update)) throw new Error('The Candyland editor state is invalid.');
    const value = Object.fromEntries(safeEntries(update));
    if (Object.prototype.hasOwnProperty.call(value, 'active')) {
      if (typeof value.active !== 'boolean') throw new Error('The Candyland editor state is invalid.');
      state.editorActive = value.active;
    }
    if (Object.prototype.hasOwnProperty.call(value, 'dirty')) {
      if (typeof value.dirty !== 'boolean') throw new Error('The Candyland editor state is invalid.');
      state.editorDirty = value.dirty;
    }
    wakeEditorWaiters(state);
  };

  const baseStateForWrite = (raw) => {
    const current = readStateFromRaw(raw);
    if (current) return current;
    if (!seedState || !validateState(seedState)) {
      throw new Error('Candyland defaults are unavailable. Local data was not changed.');
    }
    return canonicalState(seedState);
  };

  const writeFullStateUnlocked = (candidate, source, assertCurrent = () => {}) => {
    if (!validateState(candidate)) throw new Error('The Candyland app state is invalid.');
    const value = canonicalState(candidate);
    const snapshot = captureRaw([STORAGE_KEYS.state]);
    const previous = readStateFromRaw(snapshot[0].raw);
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.state,
      raw: JSON.stringify(value),
    }], 'Candyland app data');
    storageWarnings.state = '';
    dispatchChange('state', source);
    return previous;
  };

  const applyPreferencesUnlocked = (candidate, source, assertCurrent = () => {}) => {
    if (!validatePreferences(candidate)) {
      throw new Error('The synchronized Candyland preferences are invalid.');
    }
    const snapshot = captureRaw([STORAGE_KEYS.state]);
    const current = baseStateForWrite(snapshot[0].raw);
    const value = canonicalPreferences(candidate);
    current.selectedClassId = value.selectedClassId;
    current.noticeHidden = value.noticeHidden;
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.state,
      raw: JSON.stringify(canonicalState(current)),
    }], 'Candyland preferences');
    storageWarnings.state = '';
    dispatchChange('preferences', source);
    return true;
  };

  const listClassesUnlocked = async () => {
    const snapshot = captureRaw([STORAGE_KEYS.state]);
    const current = readStateFromRaw(snapshot[0].raw);
    if (!current) return [];
    const records = await identifyClasses(current.classes);
    assertRawUnchanged(snapshot, 'Candyland class data');
    return records.map(({ recordId, value }) => ({ recordId, value }));
  };

  const applyClassUnlocked = async (
    recordId,
    candidate,
    deleted,
    source,
    assertCurrent = () => {},
  ) => {
    if (!/^class-[a-f0-9]{64}$/.test(recordId || '')) {
      throw new Error('The synchronized Candyland class ID is invalid.');
    }
    const snapshot = captureRaw([STORAGE_KEYS.state]);
    const current = baseStateForWrite(snapshot[0].raw);
    const identified = await identifyClasses(current.classes);
    assertRawUnchanged(snapshot, 'Candyland class data');
    const matches = identified.filter((item) => item.recordId === recordId);
    if (matches.length > 1) {
      throw new Error('Local Candyland class identities collide and need review.');
    }
    if (deleted) {
      if (!matches.length) {
        assertCurrent();
        assertRawUnchanged(snapshot, 'Candyland class data');
        return true;
      }
      if (current.classes.length === 1) {
        throw new Error('The final Candyland class cannot be deleted.');
      }
      current.classes = current.classes.filter((group) => group.id !== matches[0].sourceId);
    } else {
      if (!validateClass(candidate, recordId)) {
        throw new Error('The synchronized Candyland class is invalid.');
      }
      const value = canonicalClass(candidate);
      if (await classRecordId(value.id) !== recordId) {
        throw new Error('The synchronized Candyland class identity does not match its record.');
      }
      if (matches.length && matches[0].sourceId !== value.id) {
        throw new Error('The synchronized Candyland class identity collides with local data.');
      }
      const index = current.classes.findIndex((group) => group.id === value.id);
      if (index >= 0) current.classes[index] = value;
      else current.classes.push(value);
    }
    if (!validateState(current)) {
      throw new Error('The synchronized Candyland class would make local data invalid.');
    }
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.state,
      raw: JSON.stringify(canonicalState(current)),
    }], 'Candyland class data');
    storageWarnings.state = '';
    dispatchChange('classes', source);
    return true;
  };

  const listTurnsUnlocked = async () => {
    const snapshot = captureRaw([STORAGE_KEYS.state]);
    const current = readStateFromRaw(snapshot[0].raw);
    if (!current) return [];
    const records = await identifyTurns(current.history);
    assertRawUnchanged(snapshot, 'Candyland turn data');
    return records.map(({ recordId, value }) => ({ recordId, value }));
  };

  const applyTurnUnlocked = async (
    recordId,
    candidate,
    deleted,
    source,
    assertCurrent = () => {},
  ) => {
    if (!/^turn-[a-f0-9]{64}$/.test(recordId || '')) {
      throw new Error('The synchronized Candyland turn ID is invalid.');
    }
    const snapshot = captureRaw([STORAGE_KEYS.state]);
    const current = baseStateForWrite(snapshot[0].raw);
    const identified = await identifyTurns(current.history);
    assertRawUnchanged(snapshot, 'Candyland turn data');
    const matches = identified.filter((item) => item.recordId === recordId);
    if (matches.length > 1) {
      throw new Error('Local Candyland turn identities collide and need review.');
    }
    if (deleted) {
      if (!matches.length) {
        assertCurrent();
        assertRawUnchanged(snapshot, 'Candyland turn data');
        return true;
      }
      current.history = current.history.filter((turn) => turn.id !== matches[0].sourceId);
    } else {
      if (!validateTurn(candidate, recordId)) {
        throw new Error('The synchronized Candyland turn is invalid.');
      }
      const value = canonicalTurn(candidate);
      if (await turnRecordId(value.id) !== recordId) {
        throw new Error('The synchronized Candyland turn identity does not match its record.');
      }
      if (matches.length && matches[0].sourceId !== value.id) {
        throw new Error('The synchronized Candyland turn identity collides with local data.');
      }
      const index = current.history.findIndex((turn) => turn.id === value.id);
      if (index >= 0) current.history[index] = value;
      else current.history.push(value);
    }
    if (!validateState(current)) {
      throw new Error('The synchronized Candyland turn would make local data invalid.');
    }
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.state,
      raw: JSON.stringify(canonicalState(current)),
    }], 'Candyland turn data');
    storageWarnings.state = '';
    dispatchChange('history-turns', source);
    return true;
  };

  const applySoundUnlocked = (candidate, source, assertCurrent = () => {}) => {
    if (!validateSound(candidate)) {
      throw new Error('The synchronized Candyland sound preference is invalid.');
    }
    const snapshot = captureRaw([STORAGE_KEYS.sound]);
    readSoundFromRaw(snapshot[0].raw);
    const value = canonicalSound(candidate);
    assertCurrent();
    compareAndSet(snapshot, [{
      key: STORAGE_KEYS.sound,
      raw: value.enabled ? 'on' : 'off',
    }], 'Candyland sound preference');
    storageWarnings.sound = '';
    dispatchChange('sound', source);
    return true;
  };

  const requireWriteSource = (metadata) => {
    if (!metadata || !['local', 'remote-migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid local write source.');
    }
  };

  const requireRemoteSource = (metadata) => {
    if (!metadata || !['remote', 'migration'].includes(metadata.source)) {
      throw new Error('The sync client requested an invalid remote write source.');
    }
  };

  const rejectFixedTombstone = (metadata, label) => {
    if (metadata && metadata.deleted) {
      throw new Error(`${label} is a fixed record and cannot be deleted.`);
    }
  };

  const localOrMigratedWrite = (group, metadata, task) => {
    requireWriteSource(metadata);
    return metadata.source === 'remote-migration'
      ? withRemoteWrite(group, task)
      : withAggregateLock(() => task(() => {}));
  };

  const readPreferencesUnlocked = () => {
    const current = readStateUnlocked();
    return current ? preferencesFromState(current) : undefined;
  };

  const makeAdapters = () => ({
    preferences: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'preferences',
      recordId: 'current',
      schemaVersion: SCHEMA_VERSION,
      validate: validatePreferences,
      readLocal: () => withConsistentRead('state', readPreferencesUnlocked),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, 'Candyland preferences');
        return localOrMigratedWrite('state', metadata, (assertCurrent) =>
          applyPreferencesUnlocked(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, 'Candyland preferences');
        return withRemoteWrite('state', (assertCurrent) =>
          applyPreferencesUnlocked(value, metadata.source, assertCurrent));
      },
    },
    classes: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'classes',
      schemaVersion: SCHEMA_VERSION,
      validate: validateClass,
      listLocal: () => withConsistentRead('state', listClassesUnlocked),
      writeLocal: (recordId, value, metadata) =>
        localOrMigratedWrite('state', metadata, (assertCurrent) =>
          applyClassUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          )),
      applyRemote: (recordId, value, metadata) => {
        requireRemoteSource(metadata);
        return withRemoteWrite('state', (assertCurrent) =>
          applyClassUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          ));
      },
    },
    turns: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'history-turns',
      schemaVersion: SCHEMA_VERSION,
      validate: validateTurn,
      listLocal: () => withConsistentRead('state', listTurnsUnlocked),
      writeLocal: (recordId, value, metadata) =>
        localOrMigratedWrite('state', metadata, (assertCurrent) =>
          applyTurnUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          )),
      applyRemote: (recordId, value, metadata) => {
        requireRemoteSource(metadata);
        return withRemoteWrite('state', (assertCurrent) =>
          applyTurnUnlocked(
            recordId,
            value,
            Boolean(metadata.deleted),
            metadata.source,
            assertCurrent,
          ));
      },
    },
    sound: {
      scope: APP_ID,
      appId: APP_ID,
      collection: 'preferences',
      recordId: 'sound',
      schemaVersion: SCHEMA_VERSION,
      validate: validateSound,
      readLocal: () => withConsistentRead('sound', readSoundUnlocked),
      writeLocal: (value, metadata) => {
        rejectFixedTombstone(metadata, 'Candyland sound preference');
        return localOrMigratedWrite('sound', metadata, (assertCurrent) =>
          applySoundUnlocked(value, metadata.source, assertCurrent));
      },
      applyRemote: (value, metadata) => {
        requireRemoteSource(metadata);
        rejectFixedTombstone(metadata, 'Candyland sound preference');
        return withRemoteWrite('sound', (assertCurrent) =>
          applySoundUnlocked(value, metadata.source, assertCurrent));
      },
    },
  });

  const attachHandles = (next) => {
    if (!exactKeys(next, ['preferences', 'classes', 'turns', 'sound'])) {
      throw new Error('Candyland sync handles are incomplete.');
    }
    const value = Object.fromEntries(safeEntries(next));
    if (!value.preferences || typeof value.preferences.save !== 'function' ||
        !value.classes || typeof value.classes.save !== 'function' ||
        typeof value.classes.remove !== 'function' ||
        !value.turns || typeof value.turns.save !== 'function' ||
        typeof value.turns.remove !== 'function' ||
        !value.sound || typeof value.sound.save !== 'function') {
      throw new Error('Candyland sync handles are incomplete.');
    }
    handles = Object.freeze({ ...value });
  };

  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);

  const stageStateChanges = async (previous, current) => {
    if (!handles) return;
    const previousPreferences = previous ? preferencesFromState(previous) : undefined;
    const nextPreferences = preferencesFromState(current);
    if (!previousPreferences || !sameValue(previousPreferences, nextPreferences)) {
      await handles.preferences.save(nextPreferences);
    }

    const oldClasses = previous ? await identifyClasses(previous.classes) : [];
    const newClasses = await identifyClasses(current.classes);
    const oldClassById = new Map(oldClasses.map((item) => [item.recordId, item]));
    const newClassById = new Map(newClasses.map((item) => [item.recordId, item]));
    for (const item of newClasses) {
      if (!oldClassById.has(item.recordId) ||
          !sameValue(oldClassById.get(item.recordId).value, item.value)) {
        await handles.classes.save(item.recordId, item.value);
      }
    }
    for (const item of oldClasses) {
      if (!newClassById.has(item.recordId)) await handles.classes.remove(item.recordId);
    }

    const oldTurns = previous ? await identifyTurns(previous.history) : [];
    const newTurns = await identifyTurns(current.history);
    const oldTurnById = new Map(oldTurns.map((item) => [item.recordId, item]));
    const newTurnById = new Map(newTurns.map((item) => [item.recordId, item]));
    for (const item of newTurns) {
      if (!oldTurnById.has(item.recordId) ||
          !sameValue(oldTurnById.get(item.recordId).value, item.value)) {
        await handles.turns.save(item.recordId, item.value);
      }
    }
    for (const item of oldTurns) {
      if (!newTurnById.has(item.recordId)) await handles.turns.remove(item.recordId);
    }
  };

  const saveState = (candidate) => {
    if (!validateState(candidate)) {
      return Promise.reject(new Error('The Candyland app state is invalid.'));
    }
    const value = canonicalState(candidate);
    return enqueueLatest('state', 'aggregate', async () => {
      const previous = await withAggregateLock(() =>
        writeFullStateUnlocked(value, 'local'));
      await stageStateChanges(previous, value);
      return true;
    });
  };

  const saveSound = (enabled) => {
    const value = { version: SCHEMA_VERSION, enabled };
    if (!validateSound(value)) {
      return Promise.reject(new Error('The Candyland sound preference is invalid.'));
    }
    return enqueueLatest('sound', 'sound', async () => {
      await withAggregateLock(() => applySoundUnlocked(value, 'local'));
      if (handles) await handles.sound.save(value);
      return true;
    });
  };

  const loadState = (fallback) => {
    if (!validateState(fallback)) {
      throw new Error('Candyland defaults are invalid.');
    }
    seedState = canonicalState(fallback);
    try {
      const current = readStateUnlocked();
      storageWarnings.state = '';
      return current || canonicalState(seedState);
    } catch (error) {
      storageWarnings.state = error.message;
      return canonicalState(seedState);
    }
  };

  const loadSound = (fallback = true) => {
    if (typeof fallback !== 'boolean') throw new Error('The sound fallback is invalid.');
    try {
      const current = readSoundUnlocked();
      storageWarnings.sound = '';
      return current ? current.enabled : fallback;
    } catch (error) {
      storageWarnings.sound = error.message;
      return fallback;
    }
  };

  const assertOwnedStorageValid = () => {
    readStateUnlocked();
    readSoundUnlocked();
    return true;
  };

  const rawBackup = () => ({
    version: 1,
    kind: 'candyland_circle_quest_browser_local_raw_backup',
    app_id: APP_ID,
    exported_at: new Date().toISOString(),
    records: RAW_BACKUP_KEYS.map((key) => {
      const rawValue = window.localStorage.getItem(key);
      return {
        key,
        present: rawValue !== null,
        raw_value: rawValue,
      };
    }),
  });

  window.CandylandStorage = Object.freeze({
    appId: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    changeEvent: CHANGE_EVENT,
    aggregateLock: AGGREGATE_LOCK,
    storageKeys: STORAGE_KEYS,
    rawBackupKeys: RAW_BACKUP_KEYS,
    rawBackup,
    validateState,
    canonicalState,
    validatePreferences,
    validateClass,
    validateTurn,
    validateSound,
    classRecordId,
    turnRecordId,
    makeAdapters,
    attachHandles,
    setEditorState,
    saveState,
    saveSound,
    loadState,
    loadSound,
    assertOwnedStorageValid,
    getStorageWarning: () =>
      [storageWarnings.state, storageWarnings.sound].filter(Boolean).join(' '),
  });
})();
