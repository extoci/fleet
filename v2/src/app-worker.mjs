import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(workerData.database);
db.exec(
  "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
);
const app = (await import(workerData.module)).default;
if (!app || typeof app !== "object")
  throw new Error("server/index.ts must export a default app definition.");
const key = (value) => {
  if (typeof value !== "string" || value.length > 512)
    throw new Error("Data keys must be strings of at most 512 characters.");
  return value;
};
let queue = Promise.resolve();
parentPort.on("message", (message) => {
  queue = queue
    .then(async () => {
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
        if (transaction) db.exec("ROLLBACK");
        parentPort.postMessage({ id: message.id, error: error.message });
      }
    })
    .catch((error) =>
      parentPort.postMessage({ id: message.id, error: error.message }),
    );
});
parentPort.postMessage({
  ready: true,
  operations: Object.fromEntries(
    ["queries", "mutations", "jobs"].map((k) => [k, Object.keys(app[k] || {})]),
  ),
});
