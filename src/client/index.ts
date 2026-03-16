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
   * Branches can have an optional timeout (ms). If a branch is waiting
   * and the timeout fires, it's treated as a retry → next branch.
   *
   * ```ts
   * await tx.select(
   *   { fn: () => tryProvider(tx, "printful"), timeout: 3000 },
   *   { fn: () => tryProvider(tx, "printify"), timeout: 5000 },
   *   async () => tryProvider(tx, "gooten"),  // no timeout
   * );
   * ```
   */
  select<T>(...branches: SelectBranch<T>[]): Promise<T>;
}

export type STMHandler<T> = (tx: TX) => Promise<T>;

/** Returned by atomic() when the transaction called retry(). */
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

// ── Transaction context implementation ─────────────────────────────────

class TXImpl implements TX {
  readSet: Record<string, unknown> = {};
  writeSet: Record<string, unknown> = {};
  // Timeout TVars to schedule if the transaction retries
  pendingTimeouts: { key: string; ms: number }[] = [];

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

    try {
      return await fn1();
    } catch (e) {
      if (!isRetrySignal(e)) throw e;
      const fn1Reads = { ...this.readSet };
      this.readSet = savedReadSet;
      this.writeSet = savedWriteSet;
      this.pendingTimeouts = savedTimeouts;
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

    // Wrap each branch: if it has a timeout, read a timeout TVar so it's
    // in the read set, and register the timeout for scheduling on retry.
    const fns = branches.map((b) => {
      if (typeof b === "function") return b;
      const { fn, timeout } = b;
      if (!timeout) return fn;

      return async () => {
        // Generate a unique timeout TVar key for this branch
        const timeoutKey = `__timeout:${Math.random().toString(36).slice(2)}`;
        // Read the timeout TVar — puts it in the read set
        const timedOut = await this.read(timeoutKey);
        if (timedOut) {
          // Timeout fired — treat as retry (skip this branch)
          this.retry();
        }
        // Register: if we block, schedule writing this TVar after `timeout` ms
        this.pendingTimeouts.push({ key: timeoutKey, ms: timeout });
        return await fn();
      };
    });

    return await fns.reduceRight(
      (rest, fn) => async () => await this.orElse(fn, rest),
    )();
  }
}

// ── STM Client ─────────────────────────────────────────────────────────

type MutationCtx = GenericMutationCtx<GenericDataModel>;

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

    const writes = Object.entries(tx.writeSet).map(([key, val]) => ({
      key,
      value: val,
    }));
    if (writes.length > 0) {
      await ctx.runMutation(this.component.lib.commit, { writes });
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

    // Transaction retried. Register waiters if callback provided.
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
        // Schedule timeouts: write the timeout TVar after N ms,
        // which wakes the waiter → transaction re-runs → sees timedOut=true → skips branch
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

  async init(ctx: MutationCtx, key: string, value: unknown): Promise<void> {
    await ctx.runMutation(this.component.lib.init, { key, value });
  }
}
