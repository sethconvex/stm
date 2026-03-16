import type {
  GenericMutationCtx,
  GenericDataModel,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

// ── Public types ───────────────────────────────────────────────────────

/**
 * Transaction context passed to the user's STM handler function.
 * Provides read, write, retry, and orElse.
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
  /** Try alternatives in order. First one that doesn't retry wins. */
  select<T>(...fns: (() => Promise<T>)[]): Promise<T>;
}

export type STMHandler<T> = (tx: TX) => Promise<T>;

/** Returned by atomic() when the transaction called retry(). */
export type STMResult<T> =
  | { status: "committed"; value: T }
  | { status: "retry"; readSet: Record<string, unknown> };

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

  constructor(
    private ctx: MutationCtx,
    private component: ComponentApi,
  ) {}

  async read(key: string): Promise<unknown> {
    // Read-your-writes: check writeSet first.
    if (key in this.writeSet) return this.writeSet[key];
    // Already read in this transaction? Return cached value.
    if (key in this.readSet) return this.readSet[key];
    // Fetch on demand — within the parent mutation's OCC transaction.
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
    // Save current state.
    const savedReadSet = { ...this.readSet };
    const savedWriteSet = { ...this.writeSet };

    try {
      return await fn1();
    } catch (e) {
      if (!isRetrySignal(e)) throw e;

      // fn1 retried. Keep its reads (for the combined watch set),
      // but discard its writes.
      const fn1Reads = { ...this.readSet };
      this.readSet = savedReadSet;
      this.writeSet = savedWriteSet;
      Object.assign(this.readSet, fn1Reads);

      // Try fn2. If it also retries, the RetrySignal propagates
      // with the merged readSet covering both branches.
      return await fn2();
    }
  }

  async select<T>(...fns: (() => Promise<T>)[]): Promise<T> {
    if (fns.length === 0) this.retry();
    if (fns.length === 1) return await fns[0]();
    // foldr1 orElse: try each in order, fall back on retry
    return await fns.reduceRight(
      (rest, fn) => async () => await this.orElse(fn, rest),
    )();
  }
}

// ── STM Client ─────────────────────────────────────────────────────────

type MutationCtx = GenericMutationCtx<GenericDataModel>;

/**
 * The STM client. Instantiate once with `new STM(components.stm)`.
 *
 * Usage:
 * ```ts
 * const stm = new STM(components.stm);
 *
 * export const transfer = mutation(async (ctx) => {
 *   const result = await stm.atomic(ctx, async (tx) => {
 *     const a = await tx.read("account-a") as number;
 *     const b = await tx.read("account-b") as number;
 *     if (a < 100) tx.retry();
 *     tx.write("account-a", a - 100);
 *     tx.write("account-b", b + 100);
 *     return "transferred";
 *   });
 * });
 * ```
 */
export class STM {
  constructor(private component: ComponentApi) {}

  /**
   * Run a transaction. TVars are fetched on demand — no need to
   * declare keys upfront. All reads happen within the parent mutation's
   * OCC transaction, so they're consistent with the commit.
   */
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
        return { status: "retry", readSet: tx.readSet };
      }
      throw e; // Propagate non-retry exceptions (abort semantics).
    }

    // Commit — apply all writes atomically.
    const writes = Object.entries(tx.writeSet).map(([key, val]) => ({
      key,
      value: val,
    }));
    if (writes.length > 0) {
      await ctx.runMutation(this.component.lib.commit, { writes });
    }

    return { status: "committed", value };
  }

  /**
   * Run a transaction atomically. Convenience wrapper around run().
   *
   * Returns { committed: true, value } on success,
   * or { committed: false } if the handler called retry().
   *
   * If onRetry is provided, registers waiters so the caller is woken
   * when a watched TVar changes.
   */
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
      if (!safeToBlock) {
        return { committed: false };
      }
    }

    return { committed: false };
  }

  /**
   * Initialize a TVar if it doesn't already exist.
   */
  async init(ctx: MutationCtx, key: string, value: unknown): Promise<void> {
    await ctx.runMutation(this.component.lib.init, { key, value });
  }
}
