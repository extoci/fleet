import fs from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import zlib from "node:zlib";
import { Worker } from "node:worker_threads";
import { pipeline } from "node:stream/promises";
import * as esbuild from "esbuild";
import { parseEnv } from "node:util";
import { read, write, manifest, headMetadata } from "./state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const reactAliases = {
  react: "preact/compat",
  "react-dom": "preact/compat",
  "react-dom/client": "preact/compat/client",
  "react/jsx-runtime": "preact/jsx-runtime",
  "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
};
const fleetPreact = {
  name: "fleet-preact",
  setup(build) {
    build.onResolve({ filter: /^(preact|react|react-dom)(\/|$)/ }, ({ path }) => {
      const target =
        path === "preact" || path.startsWith("preact/") ? path : reactAliases[path];
      if (target) return { path: fileURLToPath(import.meta.resolve(target)) };
    });
  },
};
function signature(directory) {
  const files = [];
  const publicFiles = [];
  const publicRoot = path.join(directory, "public");
  const publicInputs = [publicRoot];
  function walk(dir, isPublic = false) {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        !isPublic &&
        (item.name.startsWith(".") ||
          ["node_modules", "dist", "target"].includes(item.name))
      )
        continue;
      const file = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (isPublic) publicInputs.push(file);
        walk(file, isPublic || file === publicRoot);
      } else if (item.isFile()) {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) continue;
        const changed = isPublic ? `:${stat.ctimeMs}` : "";
        files.push(`${file}:${stat.mtimeMs}:${stat.size}${changed}`);
        if (isPublic) {
          publicInputs.push(file);
          publicFiles.push(file);
        }
      }
      if (files.length > 10000)
        throw new Error(
          "App source exceeds 10,000 files. Keep generated files in dist or a hidden directory.",
        );
    }
  }
  walk(directory);
  files.push(inputStamp([path.join(directory, ".env.fleet.server")]));
  const stamp = createHash("sha256").update(files.sort().join("\n")).digest("hex");
  return { stamp, publicRoot, publicFiles, publicInputs };
}
async function snapshotPublic(dir, root, files) {
  const target = path.join(dir, "public");
  if (!files.length || fs.existsSync(target)) return;
  const staging = fs.mkdtempSync(path.join(dir, ".public-"));
  try {
    for (const file of files) {
      const source = await open(
        file,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      try {
        const opened = await source.stat();
        const current = fs.lstatSync(file);
        if (
          !opened.isFile() ||
          opened.dev !== current.dev ||
          opened.ino !== current.ino ||
          fs.realpathSync(file) !== file
        )
          throw new Error("A public file changed during the build.");
        const output = path.join(staging, path.relative(root, file));
        fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
        await pipeline(
          source.createReadStream(),
          fs.createWriteStream(output, { mode: 0o600 }),
        );
      } finally {
        await source.close();
      }
    }
    fs.renameSync(staging, target);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
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
    this.terminations = new Map();
    this.revisionListeners = new Set();
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
          operations: last?.operations,
          head: last?.head || {},
          hasPublic: last?.hasPublic || false,
        };
        try {
          state.watcher = fs.watch(
            app.directory,
            { recursive: true },
            (_event, name) => {
              const parts = String(name || "").split(/[\\/]/);
              if (
                parts[0] === "public" ||
                !parts.some(
                  (part) =>
                    part.startsWith(".") ||
                    ["node_modules", "dist", "target"].includes(part),
                )
              ) {
                state.dirty = true;
                this.scheduleBuild(state);
              }
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
        clearTimeout(app.rebuild);
        this.unload(app);
        this.apps.delete(id);
      }
  }
  // Build soon after an edit instead of waiting for the next tick. Editors
  // emit several events per save, so wait for them to settle.
  scheduleBuild(app) {
    if (this.closed || this.apps.get(app.id) !== app) return;
    clearTimeout(app.rebuild);
    app.rebuild = setTimeout(() => {
      app.rebuild = null;
      if (this.closed || !this.apps.has(app.id)) return;
      if (app.building) {
        app.building.then(
          () => this.scheduleBuild(app),
          () => this.scheduleBuild(app),
        );
        return;
      }
      this.build(app).catch((error) => {
        app.buildError = error.message;
      });
    }, 250);
    app.rebuild.unref?.();
  }
  onRevision(listener) {
    this.revisionListeners.add(listener);
    return () => this.revisionListeners.delete(listener);
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
      head: a.head,
      hasPublic: a.hasPublic,
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
        "public",
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
      const { stamp, publicRoot, publicFiles, publicInputs } = signature(
        app.directory,
      );
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
            plugins: [fleetPreact],
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
            banner: {
              js: 'import { createRequire as __fleetCreateRequire } from "node:module"; const require = __fleetCreateRequire(import.meta.url);',
            },
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
        const operations = await this.validate(path.join(dir, "server.mjs"));
        await snapshotPublic(dir, publicRoot, publicFiles);
        if (this.closed) return false;
        const buildInputs = [
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
          );
        app.auditFiles = [...new Set([...buildInputs, ...publicInputs])];
        app.auditStamp = inputStamp(app.auditFiles);
        const next = {
          revision: stamp,
          jobs: current.jobs || [],
          operations,
          head: headMetadata(current),
          hasPublic: publicFiles.length > 0,
        };
        write(path.join(this.home, "builds", app.id, "current.json"), next);
        this.unload(app);
        Object.assign(app, next, { buildDir: dir, buildError: null });
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
        for (const listener of this.revisionListeners) listener(app);
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
            app.operations = last.operations;
            app.head = last.head || {};
            app.hasPublic = last.hasPublic || false;
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
        new URL("./validate-worker.mjs", import.meta.url),
        {
          workerData: pathToFileURL(module).href,
          resourceLimits: { maxOldGenerationSizeMb: 128 },
        },
      );
      let operations;
      worker.on("message", (message) => {
        if (message?.operations) operations = message.operations;
      });
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
        if (code !== 0)
          reject(new Error(`App module exited with code ${code}.`));
        else if (!operations) reject(new Error("App definition did not load."));
        else resolve(operations);
      });
    });
  }
  async wake(app) {
    if (app.warming) return app.warming;
    if (app.worker) {
      app.lastUsed = Date.now();
      return app.worker;
    }
    app.warming = (async () => {
      if (!(await this.build(app)))
        throw new Error("App has no successful build. Run fleet logs.");
      // Let the old worker release its SQLite connections before reopening them.
      const stopping = this.terminations.get(app.id);
      if (stopping) await stopping;
      if (this.closed) throw new Error("Fleet is stopping.");
      if (this.apps.get(app.id) !== app)
        throw new Error("App was unregistered.");
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
          if (app.worker === worker) this.unload(app);
        }, 5000);
        worker.on("message", (message) => {
          if (app.worker !== worker) return;
          if (message.ready) {
            clearTimeout(timer);
            app.lastUsed = Date.now();
            app.operations ??= message.operations;
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
          if (app.worker === worker) this.unload(app);
        });
        worker.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("App worker stopped."));
          if (app.worker === worker) this.unload(app);
        });
      });
      await ready;
      return worker;
    })().finally(() => {
      app.warming = null;
    });
    return app.warming;
  }
  async call(app, kind, name, input, user = { id: "owner" }, runId) {
    const worker = await this.wake(app);
    if (app.worker !== worker)
      throw new Error("App stopped or updated. The operation was not retried.");
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
      worker.postMessage({ id, kind, name, input, user, runId });
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
      this.terminations.set(app.id, ending);
      const clear = () => this.terminations.delete(app.id);
      ending.then(clear, clear);
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
        // Let the watcher settle a batch of edits before rebuilding.
        if (!app.rebuild)
          await this.build(app).catch((error) => {
            app.buildError = error.message;
          });
        for (const job of app.jobs || []) {
          const key = `${app.id}/${job.name}`;
          const old = state[key];
          const now = Date.now();
          const nextDue = now + job.everySeconds * 1000;
          if (!old) {
            state[key] = { due: nextDue };
            dirty = true;
            continue;
          }
          if (old.due > now) {
            if (!old.runId && old.due > nextDue) {
              state[key] = { ...old, due: nextDue };
              dirty = true;
            }
            continue;
          }
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
      clearTimeout(app.rebuild);
      this.unload(app);
    }
    await Promise.allSettled(
      [...this.apps.values()].map((app) => app.building).filter(Boolean),
    );
    await Promise.allSettled(this.terminations.values());
    while (this.ticking)
      await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
