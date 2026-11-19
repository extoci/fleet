import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import * as esbuild from "esbuild";
import { parseEnv } from "node:util";
import { read, write, manifest } from "./state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
function signature(directory) {
  const files = [];
  function walk(dir) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        item.name.startsWith(".") ||
        ["node_modules", "dist", "target"].includes(item.name)
      )
        continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) walk(file);
      else if (item.isFile()) {
        const stat = fs.statSync(file);
        files.push(`${file}:${stat.mtimeMs}:${stat.size}`);
      }
      if (files.length > 10000)
        throw new Error(
          "App source exceeds 10,000 files. Keep generated files in dist or a hidden directory.",
        );
    }
  }
  walk(directory);
  files.push(inputStamp([path.join(directory, ".env.fleet.server")]));
  return createHash("sha256").update(files.sort().join("\n")).digest("hex");
}
function inputStamp(files) {
  return files
    .map((file) => {
      try {
        const stat = fs.statSync(file);
        return `${file}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${file}:missing`;
      }
    })
    .join("|");
}
export class Runtime {
  constructor(home, { idleMs = 30_000, pollMs = 1500 } = {}) {
    this.home = home;
    this.idleMs = idleMs;
    this.apps = new Map();
    this.closed = false;
    this.terminations = new Set();
    this.timer = setInterval(
      () => this.tick().catch((e) => this.log("daemon", e.message)),
      pollMs,
    );
    this.timer.unref();
  }
  log(id, text) {
    fs.mkdirSync(path.join(this.home, "logs"), {
      recursive: true,
      mode: 0o700,
    });
    const file = path.join(this.home, "logs", `${id}.log`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1_000_000)
      fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, `${new Date().toISOString()} ${text}\n`, {
      mode: 0o600,
    });
  }
  sync() {
    const registered = read(path.join(this.home, "apps.json"), []);
    for (const app of registered) {
      if (!this.apps.has(app.id)) {
        const last = read(
          path.join(this.home, "builds", app.id, "current.json"),
          null,
        );
        const state = {
          ...app,
          worker: null,
          pending: new Map(),
          lastUsed: 0,
          buildError: null,
          building: null,
          warming: null,
          generation: 0,
          dirty: true,
          revision: last?.revision,
          buildDir: last
            ? path.join(this.home, "builds", app.id, last.revision)
            : null,
          jobs: last?.jobs || [],
        };
        try {
          state.watcher = fs.watch(
            app.directory,
            { recursive: true },
            (_event, name) => {
              if (
                !name ||
                !String(name)
                  .split(/[\\/]/)
                  .some(
                    (part) =>
                      part.startsWith(".") ||
                      ["node_modules", "dist", "target"].includes(part),
                  )
              )
                state.dirty = true;
            },
          );
          state.watcher.on("error", () => {
            state.watcher?.close();
            state.watcher = null;
            state.dirty = true;
          });
        } catch {
          state.watcher = null;
        }
        this.apps.set(app.id, state);
      }
    }
    for (const [id, app] of this.apps)
      if (!registered.some((a) => a.id === id)) {
        app.watcher?.close();
        this.unload(app);
        this.apps.delete(id);
      }
  }
  find(name) {
    this.sync();
    return [...this.apps.values()].find((a) => a.name === name);
  }
  list() {
    this.sync();
    return [...this.apps.values()].map((a) => ({
      id: a.id,
      name: a.name,
      directory: a.directory,
      running: Boolean(a.worker),
      building: Boolean(a.building),
      revision: a.revision || null,
      error: a.buildError,
      operations: a.operations || {},
      jobs: a.jobs || [],
    }));
  }
  async build(app) {
    if (app.building) return app.building;
    // Atomic editor saves can replace an inode without a second watcher event
    // on Linux. Audit only known inputs, rather than walking every idle app.
    const auditFiles =
      app.auditFiles ||
      [
        "fleet.json",
        "client/index.tsx",
        "server/index.ts",
        ".env.fleet.server",
      ].map((file) => path.join(app.directory, file));
    const audit = inputStamp(auditFiles);
    if (app.watcher && !app.dirty && audit === app.auditStamp)
      return Boolean(app.revision);
    app.auditStamp = audit;
    app.building = (async () => {
      app.dirty = false;
      const current = manifest(app.directory);
      if (current.id !== app.id || current.name !== app.name)
        throw new Error(
          "App identity changed. Restore fleet.json or explicitly unregister and register the new app.",
        );
      const stamp = signature(app.directory);
      if (stamp === app.checked) return Boolean(app.revision);
      app.checked = stamp;
      const dir = path.join(this.home, "builds", app.id, stamp);
      const options = {
        bundle: true,
        write: false,
        metafile: true,
        logLevel: "silent",
        nodePaths: [path.join(here, "..", "node_modules")],
        absWorkingDir: app.directory,
      };
      try {
        const [client, server] = await Promise.all([
          esbuild.build({
            ...options,
            entryPoints: ["client/index.tsx"],
            platform: "browser",
            format: "esm",
            jsx: "automatic",
            jsxImportSource: "preact",
            alias: { "fleet/client": path.join(here, "client.mjs") },
            outfile: "app.js",
            minify: true,
            target: ["safari16", "chrome110", "firefox115"],
            loader: { ".css": "css" },
          }),
          esbuild.build({
            ...options,
            entryPoints: ["server/index.ts"],
            platform: "node",
            format: "esm",
            outfile: "server.mjs",
            target: "node22",
          }),
        ]);
        // Never replace the current build until both halves compile and the
        // backend module loads. Validation runs without opening the app data.
        for (const output of [...client.outputFiles, ...server.outputFiles])
          write(path.join(dir, path.basename(output.path)), output.contents);
        // Compress browser assets once per build instead of on every request.
        for (const output of client.outputFiles) {
          const file = path.join(dir, path.basename(output.path));
          write(
            `${file}.br`,
            zlib.brotliCompressSync(output.contents, {
              params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
            }),
          );
          write(`${file}.gz`, zlib.gzipSync(output.contents, { level: 9 }));
        }
        await this.validate(path.join(dir, "server.mjs"));
        if (this.closed) return false;
        app.auditFiles = [
          ...new Set(
            [
              "fleet.json",
              ".env.fleet.server",
              ...Object.keys(client.metafile.inputs),
              ...Object.keys(server.metafile.inputs),
            ]
              .map((file) => path.resolve(app.directory, file))
              .filter(
                (file) =>
                  file.startsWith(app.directory + path.sep) &&
                  !file.includes(`${path.sep}node_modules${path.sep}`),
              ),
          ),
        ];
        app.auditStamp = inputStamp(app.auditFiles);
        this.unload(app);
        app.revision = stamp;
        app.buildDir = dir;
        app.buildError = null;
        app.jobs = current.jobs || [];
        write(path.join(this.home, "builds", app.id, "current.json"), {
          revision: stamp,
          jobs: app.jobs,
        });
        const parent = path.dirname(dir);
        const older = fs
          .readdirSync(parent, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== stamp)
          .map((e) => ({
            name: e.name,
            time: fs.statSync(path.join(parent, e.name)).mtimeMs,
          }))
          .sort((a, b) => b.time - a.time);
        for (const old of older.slice(2))
          fs.rmSync(path.join(parent, old.name), {
            recursive: true,
            force: true,
          });
        this.log(app.id, `Build ${stamp.slice(0, 8)} ready`);
        return true;
      } catch (error) {
        if (app.revision !== stamp)
          fs.rmSync(dir, { recursive: true, force: true });
        app.buildError =
          error.errors?.map((e) => e.text).join("\n") || error.message;
        this.log(app.id, `Build failed: ${app.buildError}`);
        if (!app.revision) {
          const last = read(
            path.join(this.home, "builds", app.id, "current.json"),
            null,
          );
          if (last) {
            app.revision = last.revision;
            app.buildDir = path.join(
              this.home,
              "builds",
              app.id,
              last.revision,
            );
            app.jobs = last.jobs;
          }
        }
        return Boolean(app.revision);
      }
    })().finally(() => {
      app.building = null;
    });
    return app.building;
  }
  validate(module) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        `import(${JSON.stringify(pathToFileURL(module).href)}).then(m=>{if(!m.default||typeof m.default!=='object')throw Error('Export a default app definition')})`,
        { eval: true, resourceLimits: { maxOldGenerationSizeMb: 128 } },
      );
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("App module initialization exceeded five seconds."));
      }, 5000);
      worker.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      worker.once("exit", (code) => {
        clearTimeout(timer);
        code === 0
          ? resolve()
          : reject(new Error(`App module exited with code ${code}.`));
      });
    });
  }
  async wake(app) {
    if (app.warming) return app.warming;
    if (app.worker) {
      app.lastUsed = Date.now();
      return;
    }
    app.warming = (async () => {
      if (!(await this.build(app)))
        throw new Error("App has no successful build. Run fleet logs.");
      if (this.closed) throw new Error("Fleet is stopping.");
      const database = path.join(this.home, "data", app.id, "app.sqlite");
      fs.mkdirSync(path.dirname(database), { recursive: true, mode: 0o700 });
      const worker = new Worker(new URL("./app-worker.mjs", import.meta.url), {
        workerData: {
          module: pathToFileURL(path.join(app.buildDir, "server.mjs")).href,
          database,
          env: fs.existsSync(path.join(app.directory, ".env.fleet.server"))
            ? parseEnv(
                fs.readFileSync(
                  path.join(app.directory, ".env.fleet.server"),
                  "utf8",
                ),
              )
            : {},
        },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
      app.worker = worker;
      app.lastUsed = Date.now();
      app.generation++;
      const ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("App startup exceeded five seconds."));
          this.unload(app);
        }, 5000);
        worker.on("message", (message) => {
          if (message.ready) {
            clearTimeout(timer);
            app.lastUsed = Date.now();
            app.operations = message.operations;
            resolve();
          } else if (message.log) this.log(app.id, message.log);
          else {
            const pending = app.pending.get(message.id);
            if (pending) {
              clearTimeout(pending.timer);
              app.pending.delete(message.id);
              app.lastUsed = Date.now();
              message.error
                ? pending.reject(new Error(message.error))
                : pending.resolve(message.value);
            }
          }
        });
        worker.once("error", (error) => {
          clearTimeout(timer);
          this.log(app.id, error.message);
          reject(error);
          this.unload(app);
        });
        worker.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("App worker stopped."));
          if (app.worker === worker) this.unload(app);
        });
      });
      await ready;
    })().finally(() => {
      app.warming = null;
    });
    return app.warming;
  }
  async call(app, kind, name, input, user = { id: "owner" }, runId) {
    await this.wake(app);
    if (app.pending.size >= 32)
      throw new Error("App is busy. Try again shortly.");
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(
        () => {
          this.log(
            app.id,
            `${kind}.${name} timed out. Its external side effects may have completed.`,
          );
          this.unload(app);
        },
        kind === "jobs" ? 30_000 : 15_000,
      );
      app.pending.set(id, { resolve, reject, timer });
      app.worker.postMessage({ id, kind, name, input, user, runId });
    });
  }
  unload(app) {
    const worker = app.worker;
    app.worker = null;
    for (const pending of app.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(
        new Error("App stopped or updated. The operation was not retried."),
      );
    }
    app.pending.clear();
    if (worker) {
      const ending = worker.terminate();
      this.terminations.add(ending);
      ending.finally(() => this.terminations.delete(ending));
    }
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      this.sync();
      const jobsFile = path.join(this.home, "jobs.json");
      const state = read(jobsFile, {});
      let dirty = false;
      for (const app of this.apps.values()) {
        await this.build(app).catch((error) => {
          app.buildError = error.message;
        });
        for (const job of app.jobs || []) {
          const key = `${app.id}/${job.name}`;
          const old = state[key];
          if (!old) {
            state[key] = { due: Date.now() + job.everySeconds * 1000 };
            dirty = true;
            continue;
          }
          if (old.due > Date.now()) continue;
          const runId = old.runId || randomUUID();
          // Persist the occurrence before execution. An interrupted job retries
          // with the same runId after restart. External effects need idempotency.
          state[key] = { ...old, runId };
          write(jobsFile, state);
          try {
            await this.call(
              app,
              "jobs",
              job.name,
              null,
              { id: "owner" },
              runId,
            );
            state[key] = {
              due: Date.now() + job.everySeconds * 1000,
              lastRun: new Date().toISOString(),
            };
            this.log(app.id, `Job ${job.name} completed`);
          } catch (error) {
            state[key] = {
              ...state[key],
              due: Date.now() + 30_000,
              error: error.message,
            };
            this.log(app.id, `Job ${job.name} failed: ${error.message}`);
          }
          dirty = true;
        }
        if (
          app.worker &&
          !app.warming &&
          !app.pending.size &&
          Date.now() - app.lastUsed > this.idleMs
        )
          this.unload(app);
      }
      if (dirty) write(jobsFile, state);
    } finally {
      this.ticking = false;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const app of this.apps.values()) {
      app.watcher?.close();
      this.unload(app);
    }
    await Promise.allSettled(
      [...this.apps.values()].map((app) => app.building).filter(Boolean),
    );
    await Promise.allSettled([...this.terminations]);
    while (this.ticking)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
