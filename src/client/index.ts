import type {
  GenericMutationCtx,
  GenericDataModel,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

// ── Public types ───────────────────────────────────────────────────────

export type SelectBranch<T> =
  | (() => Promise<T>)
  | { fn: () => Promise<T>; timeout?: number };

/**
 * Transaction context passed to the user's STM handler function.
 */
export interface TX {
  /** Read a TVar. Returns null if uninitialized. Fetched on demand. */
  read(key: string): Promise<unknown>;
  /** Write a TVar (buffered until commit). */
  write(key: string, value: unknown): void;
  /** Block until something we read changes. */
  retry(): never;
  /** Try fn1; if it retries, discard its writes and try fn2. */
  orElse<T>(fn1: () => Promise<T>, fn2: () => Promise<T>): Promise<T>;
  /**
   * Try alternatives in order. First one that doesn't retry wins.
   * Branches can have an optional timeout (ms).
   */
  select<T>(...branches: SelectBranch<T>[]): Promise<T>;

  // ── TMVar: a TVar that can be empty or full ──────────────────────
  // Like Haskell's TMVar. Blocks on take-from-empty and put-to-full.

  /**
   * Take a value from a TMVar. Blocks if empty.
   * Leaves the TMVar empty after taking.
   */
  take(key: string): Promise<unknown>;
  /**
   * Put a value into a TMVar. Blocks if already full.
   */
  put(key: string, value: unknown): Promise<void>;
  /**
   * Try to take without blocking. Returns { value } or null.
   */
  tryTake(key: string): Promise<{ value: unknown } | null>;
  /**
   * Try to put without blocking. Returns true if successful.
   */
  tryPut(key: string, value: unknown): Promise<boolean>;

  // ── afterCommit: schedule IO after the transaction succeeds ──────

  /**
   * Register a callback to run after the transaction commits.
   * Use this to schedule IO (fetch, actions) that should only
   * happen if the transaction succeeds.
   *
   * ```ts
   * await stm.atomic(ctx, async (tx) => {
   *   tx.write("order:status", "submitted");
   *   tx.afterCommit(async (ctx) => {
   *     await ctx.scheduler.runAfter(0, api.actions.callProvider, {});
   *   });
   * });
   * ```
   */
  afterCommit(fn: (ctx: MutationCtx) => Promise<void>): void;
}

export type STMHandler<T> = (tx: TX) => Promise<T>;

export type STMResult<T> =
  | { status: "committed"; value: T }
  | {
      status: "retry";
      readSet: Record<string, unknown>;
      timeouts: { key: string; ms: number }[];
    };

// ── RetrySignal ────────────────────────────────────────────────────────

class RetrySignal {
  readonly _tag = "RetrySignal" as const;
}

function isRetrySignal(e: unknown): e is RetrySignal {
  return e instanceof RetrySignal;
}

// ── TMVar encoding ─────────────────────────────────────────────────────
// A TMVar uses a regular TVar with a wrapper:
//   { __tmvar: true, empty: true }           — empty
//   { __tmvar: true, empty: false, value }   — full

const TMVAR_EMPTY = { __tmvar: true, empty: true };

function tmvarFull(value: unknown) {
  return { __tmvar: true, empty: false, value };
}

function isTMVarState(v: unknown): v is { __tmvar: true; empty: boolean; value?: unknown } {
  return v !== null && typeof v === "object" && (v as any).__tmvar === true;
}

// ── Transaction context implementation ─────────────────────────────────

type MutationCtx = GenericMutationCtx<GenericDataModel>;

class TXImpl implements TX {
  readSet: Record<string, unknown> = {};
  writeSet: Record<string, unknown> = {};
  pendingTimeouts: { key: string; ms: number }[] = [];
  afterCommitCallbacks: ((ctx: MutationCtx) => Promise<void>)[] = [];

  constructor(
    private ctx: MutationCtx,
    private component: ComponentApi,
  ) {}

  async read(key: string): Promise<unknown> {
    if (key in this.writeSet) return this.writeSet[key];
    if (key in this.readSet) return this.readSet[key];
    const val = await this.ctx.runQuery(this.component.lib.readTVar, { key });
    this.readSet[key] = val;
    return val;
  }

  write(key: string, value: unknown): void {
    this.writeSet[key] = value;
  }

  retry(): never {
    throw new RetrySignal();
  }

  async orElse<T>(fn1: () => Promise<T>, fn2: () => Promise<T>): Promise<T> {
    const savedReadSet = { ...this.readSet };
    const savedWriteSet = { ...this.writeSet };
    const savedTimeouts = [...this.pendingTimeouts];
    const savedCallbacks = [...this.afterCommitCallbacks];

    try {
      return await fn1();
    } catch (e) {
      if (!isRetrySignal(e)) throw e;
      const fn1Reads = { ...this.readSet };
      this.readSet = savedReadSet;
      this.writeSet = savedWriteSet;
      this.pendingTimeouts = savedTimeouts;
      this.afterCommitCallbacks = savedCallbacks;
      Object.assign(this.readSet, fn1Reads);
      return await fn2();
    }
  }

  async select<T>(...branches: SelectBranch<T>[]): Promise<T> {
    if (branches.length === 0) this.retry();
    if (branches.length === 1) {
      const b = branches[0];
      return typeof b === "function" ? await b() : await b.fn();
    }

    const fns = branches.map((b) => {
      if (typeof b === "function") return b;
      const { fn, timeout } = b;
      if (!timeout) return fn;

      return async () => {
        const timeoutKey = `__timeout:${Math.random().toString(36).slice(2)}`;
        const timedOut = await this.read(timeoutKey);
        if (timedOut) this.retry();
        this.pendingTimeouts.push({ key: timeoutKey, ms: timeout });
        return await fn();
      };
    });

    return await fns.reduceRight(
      (rest, fn) => async () => await this.orElse(fn, rest),
    )();
  }

  // ── TMVar operations ───────────────────────────────────────────────

  async take(key: string): Promise<unknown> {
    const state = await this.read(key);
    if (!isTMVarState(state) || state.empty) this.retry(); // empty — block
    this.write(key, TMVAR_EMPTY); // take it — leave empty
    return state.value;
  }

  async put(key: string, value: unknown): Promise<void> {
    const state = await this.read(key);
    if (isTMVarState(state) && !state.empty) this.retry(); // full — block
    this.write(key, tmvarFull(value));
  }

  async tryTake(key: string): Promise<{ value: unknown } | null> {
    const state = await this.read(key);
    if (!isTMVarState(state) || state.empty) return null;
    this.write(key, TMVAR_EMPTY);
    return { value: state.value };
  }

  async tryPut(key: string, value: unknown): Promise<boolean> {
    const state = await this.read(key);
    if (isTMVarState(state) && !state.empty) return false;
    this.write(key, tmvarFull(value));
    return true;
  }

  // ── afterCommit ────────────────────────────────────────────────────

  afterCommit(fn: (ctx: MutationCtx) => Promise<void>): void {
    this.afterCommitCallbacks.push(fn);
  }
}

// ── STM Client ─────────────────────────────────────────────────────────

export class STM {
  constructor(private component: ComponentApi) {}

  async run<T>(
    ctx: MutationCtx,
    handler: STMHandler<T>,
  ): Promise<STMResult<T>> {
    const tx = new TXImpl(ctx, this.component);

    let value: T;
    try {
      value = await handler(tx);
    } catch (e) {
      if (isRetrySignal(e)) {
        return {
          status: "retry",
          readSet: tx.readSet,
          timeouts: tx.pendingTimeouts,
        };
      }
      throw e;
    }

    // Commit writes
    const writes = Object.entries(tx.writeSet).map(([key, val]) => ({
      key,
      value: val,
    }));
    if (writes.length > 0) {
      await ctx.runMutation(this.component.lib.commit, { writes });
    }

    // Run afterCommit callbacks
    for (const cb of tx.afterCommitCallbacks) {
      await cb(ctx);
    }

    return { status: "committed", value };
  }

  async atomic<T>(
    ctx: MutationCtx,
    handler: STMHandler<T>,
    onRetry?: {
      callbackHandle: string;
      callbackArgs?: Record<string, unknown>;
    },
  ): Promise<{ committed: true; value: T } | { committed: false }> {
    const result = await this.run(ctx, handler);

    if (result.status === "committed") {
      return { committed: true, value: result.value };
    }

    if (onRetry) {
      const reads = Object.entries(result.readSet).map(([key, val]) => ({
        key,
        expectedValue: val,
      }));
      const safeToBlock = await ctx.runMutation(this.component.lib.block, {
        reads,
        callbackHandle: onRetry.callbackHandle,
        callbackArgs: onRetry.callbackArgs,
      });

      if (safeToBlock) {
        for (const { key, ms } of result.timeouts) {
          await ctx.runMutation(this.component.lib.scheduleTimeout, {
            key,
            ms,
          });
        }
      }
    }

    return { committed: false };
  }

  /** Initialize a TVar. No-op if it already exists. */
  async init(ctx: MutationCtx, key: string, value: unknown): Promise<void> {
    await ctx.runMutation(this.component.lib.init, { key, value });
  }

  /** Initialize a TMVar as empty. */
  async initTMVar(ctx: MutationCtx, key: string): Promise<void> {
    await ctx.runMutation(this.component.lib.init, { key, value: TMVAR_EMPTY });
  }

  /** Initialize a TMVar with a value (full). */
  async initTMVarFull(ctx: MutationCtx, key: string, value: unknown): Promise<void> {
    await ctx.runMutation(this.component.lib.init, { key, value: tmvarFull(value) });
  }
}
