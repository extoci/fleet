import { parentPort, workerData } from "node:worker_threads";
import { loadApp, operationNames } from "./app-definition.ts";

const app = await loadApp(workerData as string);
parentPort?.postMessage({ operations: operationNames(app) });
