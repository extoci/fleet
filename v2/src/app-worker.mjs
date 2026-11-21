import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const writeDb = new DatabaseSync(workerData.database);
writeDb.exec(
  "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
);
// WAL lets this connection read committed data while a write handler awaits.
const readDb = new DatabaseSync(workerData.database, { readOnly: true });
readDb.exec("PRAGMA busy_timeout=5000");
const app = (await import(workerData.module)).default;
if (!app || typeof app !== "object")
  throw new Error("server/index.ts must export a default app definition.");
const key = (value) => {
  if (typeof value !== "string" || value.length > 512)
    throw new Error("Data keys must be strings of at most 512 characters.");
  return value;
};
async function run(message) {
  let transaction = false;
  try {
    const { id, kind, name, input, user, runId } = message;
    if (!["queries", "mutations", "jobs"].includes(kind))
      throw new Error("Unknown operation kind.");
    if (
      !Object.hasOwn(app[kind] || {}, name) ||
      typeof app[kind][name] !== "function"
    )
      throw new Error(`No ${kind} handler named ${name}.`);
    const writable = kind !== "queries";
    const db = writable ? writeDb : readDb;
    const permit = () => {
      if (!writable)
        throw new Error("Queries cannot change data. Use a mutation.");
    };
    const ctx = {
      user,
      env: Object.freeze(workerData.env || {}),
      runId,
      db: {
        get: (name) => {
          const row = db
            .prepare("SELECT value FROM kv WHERE key=?")
            .get(key(name));
          return row ? JSON.parse(row.value) : null;
        },
        set: (name, value) => {
          permit();
          const encoded = JSON.stringify(value);
          if (encoded === undefined || encoded.length > 2_000_000)
            throw new Error("Store JSON values of at most 2 MB.");
          db.prepare(
            "INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(key(name), encoded);
          return value;
        },
        delete: (name) => {
          permit();
          return (
            db.prepare("DELETE FROM kv WHERE key=?").run(key(name))
              .changes > 0
          );
        },
        list: (prefix = "") =>
          db
            .prepare(
              "SELECT key,value FROM kv WHERE substr(key,1,?)=? ORDER BY key LIMIT 1000",
            )
            .all(key(prefix).length, prefix)
            .map((row) => ({ key: row.key, value: JSON.parse(row.value) })),
      },
      log: (...args) =>
        parentPort.postMessage({
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
    const value = await app[kind][name](ctx, input);
    const encoded = JSON.stringify(value ?? null);
    if (encoded.length > 2_000_000)
      throw new Error("Operation response exceeds 2 MB.");
    if (transaction) {
      db.exec("COMMIT");
      transaction = false;
    }
    parentPort.postMessage({ id, value: JSON.parse(encoded) });
  } catch (error) {
    if (transaction) writeDb.exec("ROLLBACK");
    throw error;
  }
}
let queue = Promise.resolve();
parentPort.on("message", (message) => {
  const execute = () =>
    run(message).catch((error) =>
      parentPort.postMessage({
        id: message.id,
        error: error?.message || String(error),
      }),
    );
  if (message.kind === "queries") void execute();
  else queue = queue.then(execute);
});
parentPort.postMessage({
  ready: true,
  operations: Object.fromEntries(
    ["queries", "mutations", "jobs"].map((k) => [k, Object.keys(app[k] || {})]),
  ),
});
