import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { read } from "./state.mjs";

function appFile(home, name) {
  const app = read(path.join(home, "apps.json"), []).find(
    (app) => app.name === name,
  );
  if (!app)
    throw new Error(
      "Unknown local app. Run this command on the checkout computer.",
    );
  const file = path.join(home, "data", app.id, "app.sqlite");
  if (!fs.existsSync(file))
    throw new Error("This app has not stored data yet.");
  return file;
}
export async function exportData(home, name, output) {
  if (fs.existsSync(output))
    throw new Error(
      "Output file already exists. Choose a new backup filename.",
    );
  const source = new DatabaseSync(appFile(home, name));
  const temp = `${output}.${randomUUID()}.tmp`;
  try {
    await backup(source, temp);
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, output);
  } finally {
    source.close();
    fs.rmSync(temp, { force: true });
  }
}
export async function restoreData(home, name, input) {
  const running = read(path.join(home, "running.json"), null);
  if (running) {
    try {
      process.kill(running.pid, 0);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    if (fs.existsSync(path.join(home, "daemon.lock")))
      throw new Error(
        "Stop Fleet before restoring data. This prevents overwriting live writes.",
      );
  }
  const destination = appFile(home, name);
  const source = new DatabaseSync(input, { readOnly: true });
  const temp = `${destination}.${randomUUID()}.restore`;
  try {
    const check = source.prepare("PRAGMA integrity_check").get();
    if (
      Object.values(check)[0] !== "ok" ||
      !source
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='kv'",
        )
        .get()
    )
      throw new Error("This file is not a valid Fleet data backup.");
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
    fs.rmSync(temp, { force: true });
  }
}
