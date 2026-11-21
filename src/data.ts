import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { type RegisteredApp, read, type RunningInfo } from "./state.ts";

function appFile(home: string, name: string): string {
  const app = read<RegisteredApp[]>(path.join(home, "apps.json"), []).find((a) => a.name === name);
  if (!app) {
    throw new Error("Unknown local app. Run this command on the checkout computer.");
  }
  const file = path.join(home, "data", app.id, "app.sqlite");
  if (!fs.existsSync(file)) {
    throw new Error("This app has not stored data yet.");
  }
  return file;
}

function removeSqliteFiles(file: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

export async function exportData(home: string, name: string, output: string): Promise<void> {
  if (fs.existsSync(output)) {
    throw new Error("Output file already exists. Choose a new backup filename.");
  }
  const source = new DatabaseSync(appFile(home, name));
  const temp = `${output}.${randomUUID()}.tmp`;
  try {
    await backup(source, temp);
    // Convert the snapshot out of WAL mode so it is a single self-contained file
    // that opens cleanly even in read-only mode on macOS.
    const snapshot = new DatabaseSync(temp);
    try {
      snapshot.exec("PRAGMA journal_mode=DELETE");
    } finally {
      snapshot.close();
    }
    fs.rmSync(`${temp}-wal`, { force: true });
    fs.rmSync(`${temp}-shm`, { force: true });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, output);
  } finally {
    source.close();
    removeSqliteFiles(temp);
  }
}

export async function restoreData(home: string, name: string, input: string): Promise<string> {
  const running = read<RunningInfo | null>(path.join(home, "running.json"), null);
  if (running) {
    try {
      process.kill(running.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    if (fs.existsSync(path.join(home, "daemon.lock"))) {
      throw new Error("Stop Fleet before restoring data. This prevents overwriting live writes.");
    }
  }
  const destination = appFile(home, name);
  const temp = `${destination}.${randomUUID()}.restore`;
  const stagedInput = `${temp}.src`;
  // Copy the backup before opening so the caller's file is never mutated even
  // if it was saved in WAL mode (which SQLite on macOS cannot open read-only
  // without a sidecar -shm file).
  fs.copyFileSync(input, stagedInput);
  fs.chmodSync(stagedInput, 0o600);
  const source = new DatabaseSync(stagedInput);
  try {
    const check = source.prepare("PRAGMA integrity_check").get() as
      Record<string, unknown> | undefined;
    if (
      !check ||
      Object.values(check)[0] !== "ok" ||
      !source.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kv'").get()
    ) {
      throw new Error("This file is not a valid Fleet data backup.");
    }
    const before = `${destination}.${Date.now()}.before-restore`;
    const previous = new DatabaseSync(destination);
    try {
      await backup(previous, before);
      fs.chmodSync(before, 0o600);
    } finally {
      previous.close();
    }
    await backup(source, temp);
    fs.chmodSync(temp, 0o600);
    fs.rmSync(`${destination}-wal`, { force: true });
    fs.rmSync(`${destination}-shm`, { force: true });
    fs.renameSync(temp, destination);
    return before;
  } finally {
    source.close();
    removeSqliteFiles(stagedInput);
    removeSqliteFiles(temp);
  }
}
