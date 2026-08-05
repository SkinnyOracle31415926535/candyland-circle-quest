/**
 * Owner-only, same-origin record synchronization used only while this app is
 * migrated. The enclosing ChatGPT Site gate authenticates the owner; this
 * handler additionally rejects requests that do not carry that identity.
 */

type PrivateSyncEnv = { DB?: D1Database };

type StoredRow = {
  record_id: string;
  revision: number;
  payload_json: string;
  updated_at: string;
};

type PublicRecord = {
  recordId: string;
  revision: number;
  value: SyncValue;
  updatedAt: string;
};

type SyncValue = {
  present: boolean;
  encoding: "json" | "text";
  value: unknown;
};

const COLLECTION = "browser-storage";
const MAX_BODY_BYTES = 1_200_000;
const MAX_VALUE_BYTES = 900 * 1024;
const MAX_DEPTH = 48;

const isObject = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === "object" && !Array.isArray(value)
);
const exactKeys = (value: unknown, expected: readonly string[]) => (
  isObject(value) && Object.keys(value).length === expected.length
  && Object.keys(value).every((key) => expected.includes(key))
);
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH || value === null) return depth <= MAX_DEPTH;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 20_000 && value.every((item) => safeJson(item, depth + 1));
  if (!isObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 20_000 && entries.every(([key, item]) => (
    key.length <= 240 && key !== "__proto__" && key !== "constructor"
    && key !== "prototype" && safeJson(item, depth + 1)
  ));
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function ownerId(request: Request): string | null {
  const value = request.headers.get("oai-authenticated-user-id")
    || request.headers.get("oai-authenticated-user-email");
  return typeof value === "string" && value.length > 0 && value.length <= 320 ? value : null;
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return Boolean(origin) && origin === new URL(request.url).origin;
}

function validRecordId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,239}$/.test(value);
}

function validateSyncValue(value: unknown): value is SyncValue {
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
  } catch {
    return false;
  }
}

function parseStoredRow(row: StoredRow): PublicRecord | null {
  try {
    const value = JSON.parse(row.payload_json) as unknown;
    if (!validateSyncValue(value)) return null;
    return {
      recordId: row.record_id,
      revision: row.revision,
      value,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

function bodyObject(value: unknown): Record<string, unknown> | null {
  return isObject(value) ? value : null;
}

async function readBody(request: Request): Promise<{ value: Record<string, unknown> } | { error: string; status: number }> {
  const contentType = request.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.startsWith("application/json")) return { error: "Use JSON for private sync.", status: 415 };
  const body = await request.text();
  if (!body || byteLength(body) > MAX_BODY_BYTES) {
    return { error: "This synchronized record is too large.", status: 413 };
  }
  try {
    const parsed = bodyObject(JSON.parse(body));
    return parsed ? { value: parsed } : { error: "The sync request is not valid JSON.", status: 400 };
  } catch {
    return { error: "The sync request is not valid JSON.", status: 400 };
  }
}

export function createPrivateAppSync(appId: string) {
  let schemaReady: Promise<void> | null = null;

  const ensureSchema = async (database: D1Database): Promise<void> => {
    if (!schemaReady) {
      schemaReady = database.batch([
        database.prepare(`CREATE TABLE IF NOT EXISTS app_sync_records (
          owner_id TEXT NOT NULL,
          app_id TEXT NOT NULL,
          collection_name TEXT NOT NULL,
          record_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (owner_id, app_id, collection_name, record_id)
        )`),
        database.prepare("CREATE INDEX IF NOT EXISTS app_sync_records_updated_at_idx ON app_sync_records (owner_id, app_id, updated_at)"),
      ]).then(() => undefined).catch((error: unknown) => {
        schemaReady = null;
        throw error;
      });
    }
    return schemaReady;
  };

  const currentRecord = async (
    database: D1Database,
    owner: string,
    recordId: string,
  ): Promise<PublicRecord | null> => {
    const result = await database.prepare(`SELECT record_id, revision, payload_json, updated_at
      FROM app_sync_records
      WHERE owner_id = ? AND app_id = ? AND collection_name = ? AND record_id = ?`)
      .bind(owner, appId, COLLECTION, recordId)
      .first<StoredRow>();
    return result ? parseStoredRow(result) : null;
  };

  const handleGet = async (request: Request, database: D1Database, owner: string): Promise<Response> => {
    if (new URL(request.url).searchParams.get("appId") !== appId) {
      return json({ error: "This sync request targets the wrong app." }, 400);
    }
    const result = await database.prepare(`SELECT record_id, revision, payload_json, updated_at
      FROM app_sync_records
      WHERE owner_id = ? AND app_id = ? AND collection_name = ?
      ORDER BY record_id COLLATE NOCASE`)
      .bind(owner, appId, COLLECTION)
      .all<StoredRow>();
    const records = result.results.map(parseStoredRow);
    if (records.some((record) => record === null)) {
      return json({ error: "A stored sync record needs review." }, 500);
    }
    return json({ version: 1, appId, collection: COLLECTION, records });
  };

  const handlePut = async (request: Request, database: D1Database, owner: string): Promise<Response> => {
    if (!sameOrigin(request)) return json({ error: "Private sync writes must come from this site." }, 403);
    const body = await readBody(request);
    if ("error" in body) return json({ error: body.error }, body.status);
    const value = body.value;
    const expectedRevision = value.expectedRevision;
    if (!exactKeys(value, ["version", "appId", "collection", "recordId", "expectedRevision", "value"])
      || value.version !== 1 || value.appId !== appId || value.collection !== COLLECTION
      || !validRecordId(value.recordId)
      || !(expectedRevision === null || (Number.isSafeInteger(expectedRevision) && expectedRevision > 0))) {
      return json({ error: "This private sync record has an unsupported schema." }, 400);
    }
    if (!validateSyncValue(value.value)) {
      return json({ error: "This private sync value has an unsupported schema." }, 400);
    }
    const payload = JSON.stringify(value.value);
    const timestamp = new Date().toISOString();
    let result;
    if (expectedRevision === null) {
      result = await database.prepare(`INSERT INTO app_sync_records
        (owner_id, app_id, collection_name, record_id, revision, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(owner_id, app_id, collection_name, record_id) DO NOTHING`)
        .bind(owner, appId, COLLECTION, value.recordId, payload, timestamp, timestamp).run();
    } else {
      result = await database.prepare(`UPDATE app_sync_records
        SET revision = revision + 1, payload_json = ?, updated_at = ?
        WHERE owner_id = ? AND app_id = ? AND collection_name = ? AND record_id = ? AND revision = ?`)
        .bind(payload, timestamp, owner, appId, COLLECTION, value.recordId, expectedRevision).run();
    }
    if (!result.meta.changes) {
      const current = await currentRecord(database, owner, value.recordId);
      return json({ error: "A newer synchronized copy needs review.", current }, 409);
    }
    const record = await currentRecord(database, owner, value.recordId);
    if (!record) return json({ error: "The synchronized record could not be verified." }, 503);
    return json({ record });
  };

  return async (request: Request, env: PrivateSyncEnv): Promise<Response> => {
    if (!env.DB) return json({ error: "Private sync storage is unavailable." }, 503);
    const owner = ownerId(request);
    if (!owner) return json({ error: "Sign in with the owner ChatGPT account to use private sync." }, 401);
    try {
      await ensureSchema(env.DB);
      if (request.method === "GET") return await handleGet(request, env.DB, owner);
      if (request.method === "PUT") return await handlePut(request, env.DB, owner);
      return json({ error: "Use GET or PUT for private sync." }, 405);
    } catch {
      return json({ error: "Private sync is temporarily unavailable. Local data is preserved." }, 503);
    }
  };
}
