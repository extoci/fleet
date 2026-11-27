import { DatabaseSync, type StatementSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { loadApp, type OperationKind, operationKinds, operationNames } from "./app-definition.ts";
import { listQuery } from "./kv-range.ts";

interface WorkerInit {
  module: string;
  database: string;
  env?: Record<string, string | undefined>;
}

interface WorkerMessage {
  id: string;
  kind: OperationKind;
  name: string;
  input: unknown;
  user: { id: string };
  runId?: string;
}

const init = workerData as WorkerInit;
const writeDb = new DatabaseSync(init.database);
writeDb.exec(
  // synchronous=NORMAL is safe under WAL — commits stay crash-consistent and
  // only lose to an OS/power failure, skipping an fsync per commit.
  "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
);
// WAL lets this connection read committed data while a write handler awaits.
const readDb = new DatabaseSync(init.database, { readOnly: true });
readDb.exec("PRAGMA busy_timeout=5000");

const app = await loadApp(init.module);

// Preparing a statement per db call costs more than the query itself.
const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();
function statement(db: DatabaseSync, sql: string): StatementSync {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}

const key = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 512) {
    throw new Error("Data keys must be strings of at most 512 characters.");
  }
  return value;
};

async function run(message: WorkerMessage): Promise<void> {
  let transaction = false;
  try {
    const { id, kind, name, input, user, runId } = message;
    if (!operationKinds.includes(kind)) {
      throw new Error("Unknown operation kind.");
    }
    const handlers = app[kind] || {};
    if (!Object.hasOwn(handlers, name) || typeof handlers[name] !== "function") {
      throw new Error(`No ${kind} handler named ${name}.`);
    }
    const writable = kind !== "queries";
    const db = writable ? writeDb : readDb;
    const permit = () => {
      if (!writable) {
        throw new Error("Queries cannot change data. Use a mutation.");
      }
    };
    const ctx = {
      user,
      env: Object.freeze(init.env || {}),
      runId,
      db: {
        get: (nameKey: string) => {
          const row = statement(db, "SELECT value FROM kv WHERE key=?").get(key(nameKey)) as
            { value: string } | undefined;
          return row ? JSON.parse(row.value) : null;
        },
        set: (nameKey: string, value: unknown) => {
          permit();
          const encoded = JSON.stringify(value);
          if (encoded === undefined || encoded.length > 2_000_000) {
            throw new Error("Store JSON values of at most 2 MB.");
          }
          statement(
            db,
            "INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(key(nameKey), encoded);
          return value;
        },
        delete: (nameKey: string) => {
          permit();
          const result = statement(db, "DELETE FROM kv WHERE key=?").run(key(nameKey));
          return Number(result.changes) > 0;
        },
        list: (prefix = "") => {
          const validPrefix = key(prefix);
          const query = listQuery(validPrefix);
          const rows = statement(db, query.sql).all(...query.params) as Array<{
            key: string;
            value: string;
          }>;
          return rows.map((row) => ({ key: row.key, value: JSON.parse(row.value) }));
        },
      },
      log: (...args: unknown[]) =>
        parentPort?.postMessage({
          log: args
            .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
            .join(" ")
            .slice(0, 4096),
        }),
    };
    if (writable) {
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
    }
    const value = await handlers[name](ctx, input);
    const encoded = JSON.stringify(value ?? null);
    if (encoded.length > 2_000_000) {
      throw new Error("Operation response exceeds 2 MB.");
    }
    if (transaction) {
      db.exec("COMMIT");
      transaction = false;
      parentPort?.postMessage({ data: true });
    }
    parentPort?.postMessage({ id, value: JSON.parse(encoded) });
  } catch (error) {
    if (transaction) writeDb.exec("ROLLBACK");
    throw error;
  }
}

let queue: Promise<void> = Promise.resolve();
parentPort?.on("message", (message: WorkerMessage) => {
  const execute = () =>
    run(message).catch((error: unknown) =>
      parentPort?.postMessage({
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  if (message.kind === "queries") void execute();
  else queue = queue.then(execute);
});

parentPort?.postMessage({
  ready: true,
  operations: operationNames(app),
});
