import {
  mutation,
  query,
  internalMutation,
  internalAction,
  httpAction,
} from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { createFunctionHandle } from "convex/server";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

const PROVIDERS = ["printful", "printify", "gooten"] as const;

// ═══════════════════════════════════════════════════════════════════════
//  The building block: try to fulfill an order with a specific provider
// ═══════════════════════════════════════════════════════════════════════
// Pure STM logic. No IO. Reads provider health + order state from TVars.
// Returns what action to take next, or retries (falls to next provider).

async function tryProvider(tx: TX, orderId: string, provider: string) {
  // Is this provider online?
  const available = await tx.read(`provider:${provider}:available`);
  if (!available) tx.retry(); // offline — skip to next

  // What happened last time we tried this provider for this order?
  const result = await tx.read(`order:${orderId}:${provider}`);

  if (result === null) {
    // Haven't tried yet. Mark as submitted.
    tx.write(`order:${orderId}:${provider}`, "submitted");
    return { next: "submit" as const, provider };
  }
  if (result === "submitted") {
    // Waiting for webhook. Block until it arrives.
    tx.retry();
  }
  if (result === "accepted") {
    // This provider shipped it!
    return { next: "done" as const, provider };
  }
  // "rejected" or "timeout" — fall through to next provider
  tx.retry();
}

// The full fulfillment transaction: try each provider in priority order.
async function fulfillTransaction(tx: TX, orderId: string) {
  return await tx.select(
    ...PROVIDERS.map(
      (p) => async () => await tryProvider(tx, orderId, p),
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Place an order
// ═══════════════════════════════════════════════════════════════════════

export const orderShirt = mutation({
  args: { design: v.string(), size: v.string() },
  handler: async (ctx, { design, size }) => {
    const orderId = await ctx.db.insert("orders", {
      design,
      size,
      status: "pending",
      attempts: [],
    });

    // Init per-order TVars for each provider
    for (const p of PROVIDERS) {
      await stm.init(ctx, `order:${orderId}:${p}`, null);
    }

    const retryHandle: string = await createFunctionHandle(
      internal.example.retryFulfillment,
    );

    const result: { committed: true; value: { next: string; provider: string } } | { committed: false } =
      await stm.atomic(
        ctx,
        async (tx) => await fulfillTransaction(tx, orderId),
        { callbackHandle: retryHandle, callbackArgs: { orderId } },
      );

    if (result.committed) {
      const { next, provider } = result.value;
      if (next === "submit") {
        await ctx.db.patch(orderId, { status: "submitted" });
        await ctx.scheduler.runAfter(0, internal.example.submitToProvider, {
          orderId,
          provider,
        });
      } else if (next === "done") {
        await ctx.db.patch(orderId, { status: "fulfilled", provider });
      }
    }

    return orderId;
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Retry callback — fired when a TVar changes (webhook result arrives)
// ═══════════════════════════════════════════════════════════════════════

export const retryFulfillment = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    if (!order || order.status === "fulfilled" || order.status === "failed")
      return;

    const retryHandle: string = await createFunctionHandle(
      internal.example.retryFulfillment,
    );

    const result: { committed: true; value: { next: string; provider: string } } | { committed: false } =
      await stm.atomic(
        ctx,
        async (tx) => await fulfillTransaction(tx, orderId),
        { callbackHandle: retryHandle, callbackArgs: { orderId } },
      );

    if (result.committed) {
      const { next, provider } = result.value;
      if (next === "submit") {
        await ctx.db.patch(orderId, { status: "submitted" });
        await ctx.scheduler.runAfter(0, internal.example.submitToProvider, {
          orderId,
          provider,
        });
      } else if (next === "done") {
        await ctx.db.patch(orderId, { status: "fulfilled", provider });
      }
    } else {
      // All providers exhausted and all rejected — mark failed
      const allRejected = await Promise.all(
        PROVIDERS.map(async (p) => {
          const r = await ctx.runQuery(components.stm.lib.readTVar, {
            key: `order:${orderId}:${p}`,
          });
          return r === "rejected" || r === "timeout";
        }),
      );
      if (allRejected.every(Boolean)) {
        await ctx.db.patch(orderId, { status: "failed" });
      }
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Submit to provider — the IO part (action with fetch)
// ═══════════════════════════════════════════════════════════════════════

export const submitToProvider = internalAction({
  args: { orderId: v.string(), provider: v.string() },
  handler: async (ctx, { orderId, provider }) => {
    // In production: fetch(`https://api.${provider}.com/orders`, { ... })
    // For the demo: simulate with a random delay and random outcome.

    const delay = 1000 + Math.random() * 3000;
    await new Promise((r) => setTimeout(r, delay));

    // 60% chance of acceptance
    const accepted = Math.random() < 0.6;
    const result = accepted ? "accepted" : "rejected";

    // Write the result back (same as what a webhook would do)
    await ctx.runMutation(internal.example.handleProviderResponse, {
      orderId,
      provider,
      result,
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Handle provider response — writes the TVar that wakes the order
// ═══════════════════════════════════════════════════════════════════════
// Called by the action (simulated) OR by the webhook endpoint (real).

export const handleProviderResponse = internalMutation({
  args: {
    orderId: v.string(),
    provider: v.string(),
    result: v.string(),
  },
  handler: async (ctx, { orderId, provider, result }) => {
    // Write the result to the order-level TVar → wakes the blocked transaction
    await stm.atomic(ctx, async (tx) => {
      tx.write(`order:${orderId}:${provider}`, result);
    });

    // Also record the attempt on the order document (for UI)
    const order = await ctx.db.get(orderId as any);
    if (order) {
      await ctx.db.patch(order._id, {
        attempts: [
          ...order.attempts,
          { provider, result, at: Date.now() },
        ],
      });
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Webhook endpoint — what a real provider would call
// ═══════════════════════════════════════════════════════════════════════

export const webhookHandler = httpAction(async (ctx, request) => {
  const body = await request.json();
  const { orderId, provider, result } = body as {
    orderId: string;
    provider: string;
    result: string;
  };

  if (!orderId || !provider || !result) {
    return new Response("Missing fields", { status: 400 });
  }

  await ctx.runMutation(internal.example.handleProviderResponse, {
    orderId,
    provider,
    result,
  });

  return new Response("OK", { status: 200 });
});

// ═══════════════════════════════════════════════════════════════════════
//  Toggle provider availability
// ═══════════════════════════════════════════════════════════════════════

export const toggleProvider = mutation({
  args: { provider: v.string() },
  handler: async (ctx, { provider }) => {
    await stm.atomic(ctx, async (tx) => {
      const current = await tx.read(`provider:${provider}:available`);
      tx.write(`provider:${provider}:available`, !current);
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Setup + reads
// ═══════════════════════════════════════════════════════════════════════

export const setup = mutation({
  args: {},
  handler: async (ctx) => {
    // All providers online
    await ctx.runMutation(components.stm.lib.commit, {
      writes: PROVIDERS.map((p) => ({
        key: `provider:${p}:available`,
        value: true,
      })),
    });
    // Clear orders
    const orders = await ctx.db.query("orders").collect();
    for (const o of orders) await ctx.db.delete(o._id);
  },
});

export const readProviders = query({
  args: {},
  handler: async (ctx) => {
    const result: Record<string, boolean> = {};
    for (const p of PROVIDERS) {
      result[p] =
        ((await ctx.runQuery(components.stm.lib.readTVar, {
          key: `provider:${p}:available`,
        })) as boolean) ?? false;
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
