import { parentPort, workerData } from "node:worker_threads";
import { loadApp, operationNames } from "./app-definition.mjs";

const app = await loadApp(workerData);
parentPort.postMessage({ operations: operationNames(app) });
