import { validateEventPattern } from "./events.ts";

export const operationKinds = ["queries", "mutations", "jobs", "events"] as const;
export type OperationKind = (typeof operationKinds)[number];

export type OperationHandler = (ctx: unknown, input: unknown) => unknown | Promise<unknown>;

export interface AppDefinition {
  queries?: Record<string, OperationHandler>;
  mutations?: Record<string, OperationHandler>;
  jobs?: Record<string, OperationHandler>;
  events?: Record<string, OperationHandler>;
}

export type OperationMap = Record<OperationKind, string[]>;

export async function loadApp(moduleUrl: string): Promise<AppDefinition> {
  const { default: app } = (await import(moduleUrl)) as { default?: AppDefinition };
  if (!app || typeof app !== "object") {
    throw new Error("server/index.ts must export a default app definition.");
  }
  return app;
}

export function operationNames(app: AppDefinition): OperationMap {
  return Object.fromEntries(
    operationKinds.map((kind) => {
      const handlers = app[kind] || {};
      const names = Object.getOwnPropertyNames(handlers).filter(
        (name) => typeof handlers[name] === "function",
      );
      if (kind === "events") {
        for (const pattern of names) validateEventPattern(pattern);
      }
      return [kind, names];
    }),
  ) as OperationMap;
}
