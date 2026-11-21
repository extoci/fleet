export const operationKinds = ["queries", "mutations", "jobs"];

export async function loadApp(module) {
  const { default: app } = await import(module);
  if (!app || typeof app !== "object")
    throw new Error("server/index.ts must export a default app definition.");
  return app;
}

export function operationNames(app) {
  return Object.fromEntries(
    operationKinds.map((kind) => {
      const handlers = app[kind] || {};
      return [
        kind,
        Object.getOwnPropertyNames(handlers).filter(
          (name) => typeof handlers[name] === "function",
        ),
      ];
    }),
  );
}
