import { mutation, query, internalMutation, httpAction } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX, SelectBranch } from "@convex-dev/stm";

const stm = new STM(components.stm);

// ═══════════════════════════════════════════════════════════════════════
//  Product catalog
// ═══════════════════════════════════════════════════════════════════════

const PROVIDERS = ["printful", "printify", "gooten"] as const;
const PRODUCTS = ["shirt", "mug", "poster"] as const;

const CATALOG: Record<string, string[]> = {
  printful: ["shirt", "mug"],
  printify: ["shirt", "poster"],
  gooten: ["mug", "poster"],
};

function providersFor(product: string) {
  return Object.entries(CATALOG)
    .filter(([, products]) => products.includes(product))
    .map(([p]) => p);
}

// ═══════════════════════════════════════════════════════════════════════
//  RACE MODE: submit to ALL providers, first to accept wins
// ═══════════════════════════════════════════════════════════════════════

// For each item, check if we have a winner. If not, check if all
// Submit ALL items to ALL providers in one pass. Retry only at the end.
// This means all items race in parallel — not one at a time.
async function fulfillCart(tx: TX, orderId: string, items: string[]) {
  const plan: { next: "done" | "submit-all"; item: string; provider?: string; providers?: string[] }[] = [];
  let allDone = true;

  for (const item of items) {
    // Already have a winner for this item?
    const winner = await tx.read(`order:${orderId}:${item}:winner`);
    if (winner) {
      plan.push({ next: "done", item, provider: winner as string });
      continue;
    }

    // No winner yet — submit to all capable providers
    allDone = false;
    const toSubmit: string[] = [];
    for (const p of providersFor(item)) {
      const available = await tx.read(`provider:${p}:available`);
      if (!available) continue;

      const status = await tx.read(`order:${orderId}:${item}:${p}`);
      if (status === null || status === "rejected" || status === "canceled") {
        tx.write(`order:${orderId}:${item}:${p}`, "submitted");
        toSubmit.push(p);
      }
    }
    if (toSubmit.length > 0) {
      plan.push({ next: "submit-all", item, providers: toSubmit });
    }
  }

  // Return the plan — even if not all done. The caller dispatches
  // actions for submit-all items and re-runs fulfillment later.
  return plan;
}

// ═══════════════════════════════════════════════════════════════════════
//  Place an order
// ═══════════════════════════════════════════════════════════════════════

export const placeOrder = mutation({
  args: { items: v.array(v.string()) },
  handler: async (ctx, { items }) => {
    const orderId = await ctx.db.insert("orders", {
      items,
      status: "pending",
      attempts: [],
    });

    // Init TVars for each item × provider + winner TVar per item
    for (const item of items) {
      await stm.init(ctx, `order:${orderId}:${item}:winner`, null);
      for (const p of providersFor(item)) {
        await stm.init(ctx, `order:${orderId}:${item}:${p}`, null);
      }
    }

    await runFulfillment(ctx, orderId, items);
    return orderId;
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Core fulfillment
// ═══════════════════════════════════════════════════════════════════════

async function runFulfillment(ctx: any, orderId: any, items: string[]) {
  const order = await ctx.db.get(orderId);
  if (!order || order.status === "fulfilled") return;

  const result = await stm.atomic(
    ctx,
    async (tx: TX) => await fulfillCart(tx, orderId, items),
  );

  if (result.committed) {
    const plan = result.value;
    // ALL items must have a winner — not just the ones in the plan
    const allDone = items.every((item) =>
      plan.some((p: any) => p.item === item && p.next === "done"),
    );

    if (allDone) {
      const assignments: Record<string, string> = {};
      for (const p of plan) assignments[p.item] = p.provider;
      await ctx.db.patch(orderId, { status: "fulfilled", assignments });
    } else {
      await ctx.db.patch(orderId, { status: "submitted" });
      for (const step of plan) {

        if (step.next === "submit-all") {
          for (const provider of step.providers) {
            console.log("scheduling submitToProvider:", step.item, provider);
            await ctx.scheduler.runAfter(0, internal.providerAction.submitToProvider, {
              orderId: orderId as string,
              items: JSON.stringify(items),
              item: step.item,
              provider,
            });
          }
        }
      }
    }
  } else {
    if (order.status === "submitted") {
      await ctx.db.patch(orderId, { status: "pending" });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Provider action is in providerAction.ts (separate file because
//  actions can't share a module with component API usage)
// ═══════════════════════════════════════════════════════════════════════


// ═══════════════════════════════════════════════════════════════════════
//  CONFIRM or CANCEL — the atomic winner selection
// ═══════════════════════════════════════════════════════════════════════
//  First provider to call this wins. Others get canceled.
//  Idempotent: calling twice returns the same answer.

export const confirmOrCancel = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider }) => {
    const items: string[] = JSON.parse(itemsJson);

    // Atomic winner selection — using component API directly
    const winner = await ctx.runQuery(components.stm.lib.readTVar, {
      key: `order:${orderId}:${item}:winner`,
    });

    let decision: string;
    if (winner === provider) {
      decision = "CONFIRM";
    } else if (winner) {
      decision = "CANCEL";
      await ctx.runMutation(components.stm.lib.commit, {
        writes: [{ key: `order:${orderId}:${item}:${provider}`, value: "canceled" }],
      });
    } else {
      decision = "CONFIRM";
      await ctx.runMutation(components.stm.lib.commit, {
        writes: [
          { key: `order:${orderId}:${item}:winner`, value: provider },
          { key: `order:${orderId}:${item}:${provider}`, value: "accepted" },
        ],
      });
    }

    const order = await ctx.db.get(orderId as any);
    if (order) {
      await ctx.db.patch(order._id, {
        attempts: [
          ...order.attempts,
          { item, provider, result: decision === "CONFIRM" ? "accepted" : "canceled", at: Date.now() },
        ],
      });
    }

    // Schedule fulfillment as a top-level mutation (not called from action chain)
    await ctx.scheduler.runAfter(0, internal.example.retryFulfillment, {
      orderId, items: itemsJson,
    });
  },
});

export const handleResponse = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string(), result: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider, result }) => {
    const items: string[] = JSON.parse(itemsJson);

    await ctx.runMutation(components.stm.lib.commit, {
      writes: [{ key: `order:${orderId}:${item}:${provider}`, value: result }],
    });

    const order = await ctx.db.get(orderId as any);
    if (order) {
      await ctx.db.patch(order._id, {
        attempts: [...order.attempts, { item, provider, result, at: Date.now() }],
      });
    }

    await ctx.scheduler.runAfter(0, internal.example.retryFulfillment, {
      orderId, items: itemsJson,
    });
  },
});

// Retry fulfillment as a top-level mutation (not in action call chain)
export const retryFulfillment = internalMutation({
  args: { orderId: v.string(), items: v.string() },
  handler: async (ctx, { orderId, items: itemsJson }) => {
    const items: string[] = JSON.parse(itemsJson);
    await runFulfillment(ctx, orderId as any, items);
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Webhook — real provider would call this
// ═══════════════════════════════════════════════════════════════════════

export const webhookHandler = httpAction(async (ctx, request) => {
  const body = await request.json() as {
    orderId: string; items: string; item: string; provider: string;
  };

  // Provider says "I'm ready" — we atomically confirm or cancel
  const result = await ctx.runMutation(internal.example.confirmOrCancel, body);

  // The response tells the provider whether to proceed
  return new Response(JSON.stringify({ decision: "see TVar" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Toggle provider + settings
// ═══════════════════════════════════════════════════════════════════════

export const toggleProvider = mutation({
  args: { provider: v.string() },
  handler: async (ctx, { provider }) => {
    let turningOn = false;
    await stm.atomic(ctx, async (tx) => {
      const current = await tx.read(`provider:${provider}:available`);
      turningOn = !current;
      tx.write(`provider:${provider}:available`, !current);
    });

    if (turningOn) {
      const orders = await ctx.db.query("orders").collect();
      for (const o of orders) {
        if (o.status === "pending" || o.status === "submitted") {
          for (const item of o.items) {
            if (providersFor(item).includes(provider)) {
              await stm.atomic(ctx, async (tx) => {
                const r = await tx.read(`order:${o._id}:${item}:${provider}`);
                if (r === "rejected" || r === "canceled")
                  tx.write(`order:${o._id}:${item}:${provider}`, null);
              });
            }
          }
          await runFulfillment(ctx, o._id, o.items);
        }
      }
    }
  },
});

export const setFailRate = mutation({
  args: { provider: v.string(), rate: v.number() },
  handler: async (ctx, { provider, rate }) => {
    await stm.atomic(ctx, async (tx) => {
      tx.write(`provider:${provider}:failRate`, rate);
    });
  },
});

export const setTimeout = mutation({
  args: { provider: v.string(), timeout: v.number() },
  handler: async (ctx, { provider, timeout }) => {
    await stm.atomic(ctx, async (tx) => {
      tx.write(`provider:${provider}:timeout`, timeout);
    });
  },
});

export const setAvailable = mutation({
  args: { provider: v.string(), available: v.boolean() },
  handler: async (ctx, { provider, available }) => {
    await stm.atomic(ctx, async (tx) => {
      tx.write(`provider:${provider}:available`, available);
    });

    if (available) {
      const orders = await ctx.db.query("orders").collect();
      for (const o of orders) {
        if (o.status === "pending" || o.status === "submitted") {
          for (const item of o.items) {
            if (providersFor(item).includes(provider)) {
              await stm.atomic(ctx, async (tx) => {
                const r = await tx.read(`order:${o._id}:${item}:${provider}`);
                if (r === "rejected" || r === "canceled")
                  tx.write(`order:${o._id}:${item}:${provider}`, null);
              });
            }
          }
          await runFulfillment(ctx, o._id, o.items);
        }
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
    await ctx.runMutation(components.stm.lib.clearAll, {});
    await ctx.runMutation(components.stm.lib.commit, {
      writes: [
        ...PROVIDERS.map((p) => ({ key: `provider:${p}:available`, value: true })),
        ...PROVIDERS.map((p) => ({ key: `provider:${p}:failRate`, value: 30 })),
        ...PROVIDERS.map((p) => ({ key: `provider:${p}:timeout`, value: 5000 })),
      ],
    });
    const orders = await ctx.db.query("orders").collect();
    for (const o of orders) await ctx.db.delete(o._id);
  },
});

export const readProviders = query({
  args: {},
  handler: async (ctx) => {
    const result: Record<string, { available: boolean; products: string[]; failRate: number; timeout: number }> = {};
    for (const p of PROVIDERS) {
      result[p] = {
        available: ((await ctx.runQuery(components.stm.lib.readTVar, { key: `provider:${p}:available` })) as boolean) ?? false,
        products: CATALOG[p],
        failRate: ((await ctx.runQuery(components.stm.lib.readTVar, { key: `provider:${p}:failRate` })) as number) ?? 30,
        timeout: ((await ctx.runQuery(components.stm.lib.readTVar, { key: `provider:${p}:timeout` })) as number) ?? 5000,
      };
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
