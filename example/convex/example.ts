import { mutation, query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

// ── The three bins in our warehouse ────────────────────────────────────

const BINS = ["gold", "silver", "bronze"] as const;
const INITIAL: Record<string, number> = { gold: 10, silver: 30, bronze: 100 };
// Total = 140, always.

// ── Setup ──────────────────────────────────────────────────────────────

export const setup = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.stm.lib.commit, {
      writes: BINS.map((r) => ({ key: r, value: INITIAL[r] })),
    });
  },
});

// ── Composable building blocks ─────────────────────────────────────────
// Plain functions. They compose freely. That's the whole point.

/** Take `amount` from a bin. Retries if insufficient. */
function take(tx: TX, bin: string, amount: number) {
  const have = tx.read(bin) as number;
  if (have < amount) tx.retry();
  tx.write(bin, have - amount);
}

/** Put `amount` into a bin. */
function put(tx: TX, bin: string, amount: number) {
  const have = tx.read(bin) as number;
  tx.write(bin, have + amount);
}

/** Move `amount` from one bin to another. Total conserved. */
function move(tx: TX, from: string, to: string, amount: number) {
  take(tx, from, amount);
  put(tx, to, amount);
}

// ── Atomic move ────────────────────────────────────────────────────────
// Both the take and put happen in ONE atomic step.
// Total across all bins NEVER changes — not even mid-transaction.

export const atomicMove = mutation({
  args: { from: v.string(), to: v.string(), amount: v.number() },
  handler: async (ctx, { from, to, amount }) => {
    return await stm.atomic(
      ctx,
      (tx) => {
        move(tx, from, to, amount);
        return `moved ${amount} from ${from} to ${to}`;
      },
      [from, to],
    );
  },
});

// ── orElse: take from best available ───────────────────────────────────
// "Take from gold. If empty, silver. If empty, bronze."
// Each branch's writes are ROLLED BACK before trying the next.
// This is impossible with a plain if/else when branches can block.

export const takeBest = mutation({
  args: { amount: v.number() },
  handler: async (ctx, { amount }) => {
    return await stm.atomic(
      ctx,
      (tx) => {
        return tx.orElse(
          () => {
            take(tx, "gold", amount);
            return "gold";
          },
          () =>
            tx.orElse(
              () => {
                take(tx, "silver", amount);
                return "silver";
              },
              () => {
                take(tx, "bronze", amount);
                return "bronze";
              },
            ),
        );
      },
      ["gold", "silver", "bronze"],
    );
  },
});

// ── Stress test: N random moves in parallel ────────────────────────────
// Every move conserves total. Run many concurrently to prove atomicity.

export const randomMove = mutation({
  args: { seed: v.number() },
  handler: async (ctx, { seed }) => {
    const bins = ["gold", "silver", "bronze"];
    const a = bins[seed % 3];
    const b = bins[(seed + 1) % 3];
    const amount = (seed % 5) + 1;
    return await stm.atomic(
      ctx,
      (tx) => {
        const have = tx.read(a) as number;
        if (have < amount) return { skipped: true };
        tx.write(a, have - amount);
        const bHave = tx.read(b) as number;
        tx.write(b, bHave + amount);
        return { moved: amount, from: a, to: b };
      },
      bins,
    );
  },
});

// ── Reads ──────────────────────────────────────────────────────────────

export const readAll = query({
  args: {},
  handler: async (ctx) => {
    const result: Record<string, number> = {};
    for (const r of BINS) {
      result[r] =
        ((await ctx.runQuery(components.stm.lib.readTVar, {
          key: r,
        })) as number) ?? 0;
    }
    return result;
  },
});

export const readAccount = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    return (await ctx.runQuery(components.stm.lib.readTVar, {
      key: name,
    })) as number | null;
  },
});
