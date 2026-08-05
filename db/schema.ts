import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Temporary owner-scoped records; removed with the migration controls. */
export const appSyncRecords = sqliteTable("app_sync_records", {
  ownerId: text("owner_id").notNull(),
  appId: text("app_id").notNull(),
  collectionName: text("collection_name").notNull(),
  recordId: text("record_id").notNull(),
  revision: integer("revision").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  primaryKey({ columns: [table.ownerId, table.appId, table.collectionName, table.recordId] }),
]);
