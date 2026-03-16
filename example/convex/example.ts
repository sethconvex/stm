import { mutation, query, internalMutation } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { createFunctionHandle } from "convex/server";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

// ═══════════════════════════════════════════════════════════════════════
//  THE BUILDING BLOCK: buy() — takes stock, retries if none available
// ═══════════════════════════════════════════════════════════════════════
// This is a plain function. It doesn't know about orders, callbacks,
// databases, or anything else. It just reads and writes TVars.
// That's the point — it composes with anything.

async function buy(tx: TX, item: string, amount: number) {
  const stock = (await tx.read(item)) as number;
  if (stock < amount) tx.retry(); // ← THE thing mutations can't do
  tx.write(item, stock - amount);
}

// ═══════════════════════════════════════════════════════════════════════
//  PLACE ORDER — tries to buy, blocks if out of stock
// ═══════════════════════════════════════════════════════════════════════
// If stock is available: order completes immediately.
// If not: order goes "pending" and auto-completes when restocked.
// No polling. No subscriptions. The STM retry→wake loop handles it.

export const placeOrder = mutation({
  args: { item: v.string(), amount: v.number() },
  handler: async (ctx, { item, amount }) => {
    // Create the order first.
    const orderId = await ctx.db.insert("orders", {
      item,
      amount,
      status: "pending",
    });

    // Get a function handle for the retry callback.
    const retryHandle: string = await createFunctionHandle(
      internal.example.retryOrder,
    );

    // Try the STM transaction.
    const result: { committed: true; value: string } | { committed: false } =
      await stm.atomic(ctx, async (tx) => {
        await buy(tx, item, amount);
        return "bought";
      }, {
      // If retry: register waiters. When the TVar changes,
      // the STM component calls retryOrder automatically.
      callbackHandle: retryHandle,
      callbackArgs: { orderId },
    });

    if (result.committed) {
      await ctx.db.patch(orderId, {
        status: "completed",
        result: `Got ${amount} ${item}`,
      });
    }
    // If not committed, order stays "pending". retryOrder will handle it.

    return { orderId, immediate: result.committed };
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  RETRY CALLBACK — called automatically by STM when a TVar changes
// ═══════════════════════════════════════════════════════════════════════
// This is the wake side of the retry→wake loop.
// The STM component's commit() schedules this via scheduler.runAfter
// when a watched TVar is written.

export const retryOrder = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.status !== "pending") return; // Already handled.

    // Get a handle for re-registering if we need to retry again.
    const retryHandle = await createFunctionHandle(
      internal.example.retryOrder,
    );

    // Re-attempt the STM transaction.
    const result = await stm.atomic(ctx, async (tx) => {
      await buy(tx, order.item, order.amount);
      return "bought";
    }, {
      callbackHandle: retryHandle,
      callbackArgs: { orderId },
    });

    if (result.committed) {
      await ctx.db.patch(orderId, {
        status: "completed",
        result: `Got ${order.amount} ${order.item}`,
      });
    }
    // If still not committed, new waiters are registered.
    // The loop continues automatically.
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  RESTOCK — adds inventory. This is what wakes blocked orders.
// ═══════════════════════════════════════════════════════════════════════
// When commit() writes the TVar, it finds waiters and fires their
// callbacks. That's the entire wake mechanism — no extra code needed.

export const restock = mutation({
  args: { item: v.string(), amount: v.number() },
  handler: async (ctx, { item, amount }) => {
    await stm.atomic(ctx, async (tx) => {
      const stock = ((await tx.read(item)) as number) ?? 0;
      tx.write(item, stock + amount);
      return stock + amount;
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  orElse — buy from warehouse A, else warehouse B
// ═══════════════════════════════════════════════════════════════════════
// Both branches can block. orElse tries A, rolls back its writes if
// it retries, then tries B. This composes blocking operations —
// something you literally cannot do with if/else in a mutation.

export const buyFromEither = mutation({
  args: { a: v.string(), b: v.string(), amount: v.number() },
  handler: async (ctx, { a, b, amount }) => {
    const orderId = await ctx.db.insert("orders", {
      item: `${a} or ${b}`,
      amount,
      status: "pending",
    });

    const retryHandle: string = await createFunctionHandle(
      internal.example.retryBuyFromEither,
    );

    const result: { committed: true; value: string } | { committed: false } =
      await stm.atomic(ctx, async (tx) => {
        return await tx.orElse(
          async () => { await buy(tx, a, amount); return a; },
          async () => { await buy(tx, b, amount); return b; },
        );
      }, {
        callbackHandle: retryHandle,
        callbackArgs: { orderId, a, b, amount },
      });

    if (result.committed) {
      await ctx.db.patch(orderId, {
        status: "completed",
        result: `Got ${amount} from ${result.value}`,
      });
    }

    return { orderId, immediate: result.committed };
  },
});

export const retryBuyFromEither = internalMutation({
  args: {
    orderId: v.id("orders"),
    a: v.string(),
    b: v.string(),
    amount: v.number(),
  },
  handler: async (ctx, { orderId, a, b, amount }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.status !== "pending") return;

    const retryHandle: string = await createFunctionHandle(
      internal.example.retryBuyFromEither,
    );

    const result: { committed: true; value: string } | { committed: false } =
      await stm.atomic(ctx, async (tx) => {
        return await tx.orElse(
          async () => { await buy(tx, a, amount); return a; },
          async () => { await buy(tx, b, amount); return b; },
        );
      }, {
        callbackHandle: retryHandle,
        callbackArgs: { orderId, a, b, amount },
      });

    if (result.committed) {
      await ctx.db.patch(orderId, {
        status: "completed",
        result: `Got ${amount} from ${result.value}`,
      });
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  SETUP + READS
// ═══════════════════════════════════════════════════════════════════════

export const setup = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.stm.lib.commit, {
      writes: [
        { key: "widgets", value: 0 },
        { key: "gadgets", value: 0 },
      ],
    });
    // Clear all orders.
    const orders = await ctx.db.query("orders").collect();
    for (const o of orders) await ctx.db.delete(o._id);
  },
});

export const readStock = query({
  args: {},
  handler: async (ctx) => {
    const widgets = ((await ctx.runQuery(components.stm.lib.readTVar, {
      key: "widgets",
    })) ?? 0) as number;
    const gadgets = ((await ctx.runQuery(components.stm.lib.readTVar, {
      key: "gadgets",
    })) ?? 0) as number;
    return { widgets, gadgets };
  },
});

export const listOrders = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("orders").order("desc").take(20);
  },
});
