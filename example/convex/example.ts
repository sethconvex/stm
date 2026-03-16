import { mutation, query, internalMutation } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { createFunctionHandle } from "convex/server";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

// ═══════════════════════════════════════════════════════════════════════
//  Reusable building block: buy from a warehouse
// ═══════════════════════════════════════════════════════════════════════
// This is just a function. It doesn't know about orders, databases,
// or callbacks. It reads stock, waits if empty, and decrements.

async function buyFrom(tx: TX, warehouse: string, amount: number) {
  const stock = (await tx.read(warehouse)) as number;
  if (stock < amount) tx.retry(); // wait until restocked
  tx.write(warehouse, stock - amount);
}

// ═══════════════════════════════════════════════════════════════════════
//  Place an order — waits if out of stock, completes when restocked
// ═══════════════════════════════════════════════════════════════════════

export const placeOrder = mutation({
  args: { warehouse: v.string(), amount: v.number() },
  handler: async (ctx, { warehouse, amount }) => {
    const orderId = await ctx.db.insert("orders", {
      item: warehouse,
      amount,
      status: "pending",
    });

    const retryHandle: string = await createFunctionHandle(
      internal.example.retryOrder,
    );

    const result: { committed: true; value: string } | { committed: false } =
      await stm.atomic(
        ctx,
        async (tx) => {
          await buyFrom(tx, warehouse, amount);
          return `Bought ${amount} from ${warehouse}`;
        },
        {
          callbackHandle: retryHandle,
          callbackArgs: { orderId },
        },
      );

    if (result.committed) {
      await ctx.db.patch(orderId, {
        status: "completed",
        result: result.value,
      });
    }

    return { orderId, immediate: result.committed };
  },
});

// Called automatically when watched stock changes
export const retryOrder = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.status !== "pending") return;

    const retryHandle = await createFunctionHandle(
      internal.example.retryOrder,
    );

    const result = await stm.atomic(
      ctx,
      async (tx) => {
        await buyFrom(tx, order.item, order.amount);
        return `Bought ${order.amount} from ${order.item}`;
      },
      { callbackHandle: retryHandle, callbackArgs: { orderId } },
    );

    if (result.committed) {
      await ctx.db.patch(orderId, {
        status: "completed",
        result: result.value,
      });
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Buy from any warehouse — tries each one in order (select/orElse)
// ═══════════════════════════════════════════════════════════════════════
// "I need 1 widget. Try US warehouse, then EU, then Asia."
// Each attempt is rolled back before trying the next.
// If all are empty, the order waits for ANY of them to restock.

const ALL_WAREHOUSES = ["us-west", "eu-central", "asia-east"];

export const buyFromAny = mutation({
  args: { amount: v.number() },
  handler: async (ctx, { amount }) => {
    const orderId = await ctx.db.insert("orders", {
      item: "any warehouse",
      amount,
      status: "pending",
    });

    const retryHandle: string = await createFunctionHandle(
      internal.example.retryBuyFromAny,
    );

    const result: { committed: true; value: string } | { committed: false } =
      await stm.atomic(
        ctx,
        async (tx) => {
          // select = try each in order, first one that has stock wins
          return await tx.select(
            ...ALL_WAREHOUSES.map(
              (wh) => async () => {
                await buyFrom(tx, wh, amount);
                return wh;
              },
            ),
          );
        },
        {
          callbackHandle: retryHandle,
          callbackArgs: { orderId, amount },
        },
      );

    if (result.committed) {
      await ctx.db.patch(orderId, {
        status: "completed",
        result: `Fulfilled from ${result.value}`,
      });
    }

    return { orderId, immediate: result.committed };
  },
});

export const retryBuyFromAny = internalMutation({
  args: { orderId: v.id("orders"), amount: v.number() },
  handler: async (ctx, { orderId, amount }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.status !== "pending") return;

    const retryHandle: string = await createFunctionHandle(
      internal.example.retryBuyFromAny,
    );

    const result: { committed: true; value: string } | { committed: false } =
      await stm.atomic(
        ctx,
        async (tx) => {
          return await tx.select(
            ...ALL_WAREHOUSES.map(
              (wh) => async () => {
                await buyFrom(tx, wh, amount);
                return wh;
              },
            ),
          );
        },
        {
          callbackHandle: retryHandle,
          callbackArgs: { orderId, amount },
        },
      );

    if (result.committed) {
      await ctx.db.patch(orderId, {
        status: "completed",
        result: `Fulfilled from ${result.value}`,
      });
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Restock a warehouse — this wakes any waiting orders
// ═══════════════════════════════════════════════════════════════════════

export const restock = mutation({
  args: { warehouse: v.string(), amount: v.number() },
  handler: async (ctx, { warehouse, amount }) => {
    await stm.atomic(ctx, async (tx) => {
      const stock = ((await tx.read(warehouse)) as number) ?? 0;
      tx.write(warehouse, stock + amount);
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Setup + reads
// ═══════════════════════════════════════════════════════════════════════

export const setup = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.runMutation(components.stm.lib.commit, {
      writes: ALL_WAREHOUSES.map((wh) => ({ key: wh, value: 0 })),
    });
    const orders = await ctx.db.query("orders").collect();
    for (const o of orders) await ctx.db.delete(o._id);
  },
});

export const readStock = query({
  args: {},
  handler: async (ctx) => {
    const result: Record<string, number> = {};
    for (const wh of ALL_WAREHOUSES) {
      result[wh] =
        ((await ctx.runQuery(components.stm.lib.readTVar, {
          key: wh,
        })) ?? 0) as number;
    }
    return result;
  },
});

export const listOrders = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("orders").order("desc").take(20);
  },
});
