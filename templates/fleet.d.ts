interface FleetDb {
  get<T = unknown>(key: string): T | null;
  set<T>(key: string, value: T): T;
  delete(key: string): boolean;
  list<T = unknown>(prefix?: string): Array<{ key: string; value: T }>;
}

interface FleetEvent {
  readonly id: string;
  readonly topic: string;
  readonly source: string;
  readonly at: string;
  readonly depth: number;
}

interface FleetCtx {
  user: { id: string };
  db: FleetDb;
  env: Readonly<Record<string, string | undefined>>;
  log(...values: unknown[]): void;
  emit(topic: string, payload?: unknown): void;
  runId?: string;
  event?: FleetEvent;
  eventId?: string;
}

declare module "fleet/server" {
  export type FleetCtx = globalThis.FleetCtx;
  export type FleetDb = globalThis.FleetDb;
  export type FleetEvent = globalThis.FleetEvent;
}

declare module "fleet/client" {
  export function call<T = unknown>(
    kind: "queries" | "mutations",
    name: string,
    input?: unknown,
    options?: { keepalive?: boolean },
  ): Promise<T>;

  /** Refreshes on pushed data changes, visibility, and reconnect. Positive pollMs opts into polling. */
  export function useQuery<T = unknown>(
    name: string,
    input?: unknown,
    options?: { pollMs?: number | false },
  ): { data: T | undefined; error: Error | null };

  export function useMutation<T = unknown, Input = unknown>(
    name: string,
    options?: { invalidate?: string[] | false },
  ): (input?: Input) => Promise<T>;
}
