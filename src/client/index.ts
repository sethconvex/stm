import type {
  GenericMutationCtx,
  GenericDataModel,
  FunctionHandle,
} from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";

// ── Public types ───────────────────────────────────────────────────────

/**
 * Transaction context passed to the user's STM handler function.
 * Provides read, write, retry, and orElse.
 */
export interface TX {
  /** Read a TVar. Returns null if uninitialized. */
  read(key: string): unknown;
  /** Write a TVar (buffered until commit). */
  write(key: string, value: unknown): void;
  /** Block until something we read changes. */
  retry(): never;
  /** Try fn1; if it retries, discard its writes and try fn2. */
  orElse<T>(fn1: () => T, fn2: () => T): T;
}

export type STMHandler<T> = (tx: TX) => T;

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

  constructor(private readonly snapshot: Record<string, unknown>) {}

  read(key: string): unknown {
    // Read-your-writes: check writeSet first.
    if (key in this.writeSet) return this.writeSet[key];
    // Then check snapshot (values fetched from DB before running handler).
    const val = this.snapshot[key] ?? null;
    this.readSet[key] = val;
    return val;
  }

  write(key: string, value: unknown): void {
    this.writeSet[key] = value;
  }

  retry(): never {
    throw new RetrySignal();
  }

  orElse<T>(fn1: () => T, fn2: () => T): T {
    // Save current state.
    const savedReadSet = { ...this.readSet };
    const savedWriteSet = { ...this.writeSet };

    try {
      return fn1();
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
      return fn2();
    }
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
 *   const result = await stm.atomic(ctx, (tx) => {
 *     const a = tx.read("account-a") as number;
 *     const b = tx.read("account-b") as number;
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
   * Run a transaction atomically.
   *
   * - Reads are from a consistent snapshot.
   * - Writes are buffered and committed atomically.
   * - retry() blocks until a read TVar changes.
   * - orElse() tries alternatives.
   *
   * Returns the handler's return value on commit,
   * or throws if the handler throws (non-retry).
   *
   * If the handler calls retry(), this method calls the component's
   * block() mutation to register waiters, and returns { status: "retry" }.
   * The caller is responsible for actually blocking (e.g. a workflow step
   * stays inProgress, or a standalone caller polls/subscribes).
   */
  async run<T>(
    ctx: MutationCtx,
    handler: STMHandler<T>,
    keys: string[],
  ): Promise<STMResult<T>> {
    // Step 1: Snapshot — read all TVars the handler might need.
    const snapshot: Record<string, unknown> = {};
    for (const key of keys) {
      const doc = await ctx.runQuery(this.component.lib.readTVar, { key });
      snapshot[key] = doc;
    }

    // Step 2: Run the handler with a fresh transaction context.
    const tx = new TXImpl(snapshot);

    let value: T;
    try {
      value = handler(tx);
    } catch (e) {
      if (isRetrySignal(e)) {
        return { status: "retry", readSet: tx.readSet };
      }
      throw e; // Propagate non-retry exceptions (abort semantics).
    }

    // Step 3: Commit — apply all writes atomically.
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
   * Convenience: run a transaction, automatically handling retry by
   * registering waiters via the block() mutation.
   *
   * `callbackHandle` is a FunctionHandle<"mutation"> that will be called
   * (via scheduler.runAfter) when a watched TVar changes.
   * This is how the caller gets "woken up."
   *
   * Returns the committed value, or null if blocked (retry).
   */
  async atomic<T>(
    ctx: MutationCtx,
    handler: STMHandler<T>,
    keys: string[],
    onRetry?: {
      callbackHandle: string;
      callbackArgs?: Record<string, unknown>;
    },
  ): Promise<{ committed: true; value: T } | { committed: false }> {
    const result = await this.run(ctx, handler, keys);

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
        // A TVar changed between read and block — retry immediately.
        // Caller should re-invoke atomic().
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
