import { mutation, query, internalMutation, internalAction, httpAction } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

const PROVIDERS = ["printful", "printify", "gooten"] as const;

// ═══════════════════════════════════════════════════════════════════════
//  The building block: try a provider for an order
// ═══════════════════════════════════════════════════════════════════════

async function tryProvider(tx: TX, orderId: string, provider: string) {
  const available = await tx.read(`provider:${provider}:available`);
  if (!available) tx.retry();

  const result = await tx.read(`order:${orderId}:${provider}`);
  if (result === null) {
    tx.write(`order:${orderId}:${provider}`, "submitted");
    return { next: "submit" as const, provider };
  }
  if (result === "submitted") tx.retry(); // waiting for response
  if (result === "accepted") return { next: "done" as const, provider };
  tx.retry(); // rejected — try next
}

async function fulfillTransaction(tx: TX, orderId: string) {
  return await tx.select(
    ...PROVIDERS.map((p) => async () => await tryProvider(tx, orderId, p)),
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Place an order
// ═══════════════════════════════════════════════════════════════════════

export const orderShirt = mutation({
  args: { design: v.string(), size: v.string() },
  handler: async (ctx, { design, size }) => {
    const orderId = await ctx.db.insert("orders", {
      design, size, status: "pending", attempts: [],
    });

    for (const p of PROVIDERS) {
      await stm.init(ctx, `order:${orderId}:${p}`, null);
    }

    // Run the fulfillment transaction. If it commits with "submit",
    // schedule the action. If it retries (all blocked), do nothing —
    // toggleProvider will re-trigger via waiter wake.
    await runFulfillment(ctx, orderId);
    return orderId;
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Core fulfillment logic — used by orderShirt, retryFulfillment,
//  and handleProviderResponse
// ═══════════════════════════════════════════════════════════════════════

async function runFulfillment(ctx: any, orderId: any) {
  const order = await ctx.db.get(orderId);
  if (!order || order.status === "fulfilled" || order.status === "failed") return;

  const result = await stm.atomic(
    ctx,
    async (tx: TX) => await fulfillTransaction(tx, orderId),
  );

  if (result.committed) {
    const { next, provider } = result.value;
    if (next === "submit") {
      await ctx.db.patch(orderId, { status: "submitted" });
      await ctx.scheduler.runAfter(0, internal.example.submitToProvider, {
        orderId: orderId as string,
        provider,
      });
    } else if (next === "done") {
      await ctx.db.patch(orderId, { status: "fulfilled", provider });
    }
  } else {
    // Check if all providers truly rejected (not just blocked)
    let allDone = true;
    for (const p of PROVIDERS) {
      const r = await ctx.runQuery(components.stm.lib.readTVar, {
        key: `order:${orderId}:${p}`,
      });
      if (r !== "rejected" && r !== "timeout") {
        allDone = false;
        break;
      }
    }
    if (allDone) {
      await ctx.db.patch(orderId, { status: "failed" });
    }
    // Otherwise: some providers are still available but blocked.
    // The STM waiter mechanism will wake us when state changes.
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Submit to provider — calls the API, then writes result + retries
// ═══════════════════════════════════════════════════════════════════════

export const submitToProvider = internalAction({
  args: { orderId: v.string(), provider: v.string() },
  handler: async (ctx, { orderId, provider }) => {
    // Simulate provider API call (1-3s delay, 60% acceptance)
    const delay = 1000 + Math.random() * 3000;
    await new Promise((r) => setTimeout(r, delay));
    const accepted = Math.random() < 0.6;
    const result = accepted ? "accepted" : "rejected";

    // Write result + re-run fulfillment in one mutation
    await ctx.runMutation(internal.example.handleAndRetry, {
      orderId, provider, result,
    });
  },
});

// Single mutation: write the webhook result, then immediately re-run
// fulfillment. No scheduling chain. No waiter cascade.
export const handleAndRetry = internalMutation({
  args: { orderId: v.string(), provider: v.string(), result: v.string() },
  handler: async (ctx, { orderId, provider, result }) => {
    // Write the provider's response to the TVar
    await stm.atomic(ctx, async (tx) => {
      tx.write(`order:${orderId}:${provider}`, result);
    });

    // Record attempt for UI
    const order = await ctx.db.get(orderId as any);
    if (order) {
      await ctx.db.patch(order._id, {
        attempts: [...order.attempts, { provider, result, at: Date.now() }],
      });
    }

    // Immediately re-run fulfillment (same mutation, no scheduling)
    await runFulfillment(ctx, orderId as any);
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Webhook endpoint — what a real provider would call
// ═══════════════════════════════════════════════════════════════════════

export const webhookHandler = httpAction(async (ctx, request) => {
  const body = await request.json() as {
    orderId: string; provider: string; result: string;
  };
  if (!body.orderId || !body.provider || !body.result) {
    return new Response("Missing fields", { status: 400 });
  }
  await ctx.runMutation(internal.example.handleAndRetry, body);
  return new Response("OK", { status: 200 });
});

// ═══════════════════════════════════════════════════════════════════════
//  Toggle provider + retry blocked orders
// ═══════════════════════════════════════════════════════════════════════

export const toggleProvider = mutation({
  args: { provider: v.string() },
  handler: async (ctx, { provider }) => {
    await stm.atomic(ctx, async (tx) => {
      const current = await tx.read(`provider:${provider}:available`);
      tx.write(`provider:${provider}:available`, !current);
    });

    // Re-try any submitted/pending orders (provider availability changed)
    const orders = await ctx.db.query("orders").collect();
    for (const o of orders) {
      if (o.status === "pending" || o.status === "submitted") {
        await runFulfillment(ctx, o._id);
      }
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Setup + reads
// ═══════════════════════════════════════════════════════════════════════

export const setup = mutation({
  args: {},
  handler: async (ctx) => {
    // Clear all STM state (TVars + stale waiters)
    await ctx.runMutation(components.stm.lib.clearAll, {});
    // Re-init provider availability
    await ctx.runMutation(components.stm.lib.commit, {
      writes: PROVIDERS.map((p) => ({
        key: `provider:${p}:available`, value: true,
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
      result[p] = ((await ctx.runQuery(components.stm.lib.readTVar, {
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
