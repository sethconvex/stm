import { mutation, query, internalMutation, httpAction } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

// ═══════════════════════════════════════════════════════════════════════
//  Catalog
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
//  Domain helpers
// ═══════════════════════════════════════════════════════════════════════

async function isProviderOnline(tx: TX, provider: string) {
  return (await tx.read(`provider:${provider}:available`)) === true;
}

async function getProviderStatus(tx: TX, orderId: string, item: string, provider: string) {
  return (await tx.read(`order:${orderId}:${item}:${provider}`)) as string | null;
}

function markSubmitted(tx: TX, orderId: string, item: string, provider: string) {
  tx.write(`order:${orderId}:${item}:${provider}`, "submitted");
}

// ═══════════════════════════════════════════════════════════════════════
//  Fulfillment — two-phase commit
// ═══════════════════════════════════════════════════════════════════════
//
//  Phase 1: Submit to all providers. They webhook "ready" or "rejected".
//  Phase 2: When ALL items have a "ready" provider → confirm all winners.
//           If timeout fires first → cancel everything.
//
//  We don't confirm any single item until the entire cart is ready.

type Plan =
  | { action: "submit"; submissions: { item: string; providers: string[] }[] }
  | { action: "confirm"; winners: { item: string; provider: string }[] }
  | { action: "wait" };

async function fulfillCart(tx: TX, orderId: string, items: string[]): Promise<Plan> {
  const needsSubmit: { item: string; providers: string[] }[] = [];
  const ready: { item: string; provider: string }[] = [];
  let allReady = true;

  for (const item of items) {
    // Find the first "ready" provider for this item
    let readyProvider: string | null = null;
    const toSubmit: string[] = [];

    for (const p of providersFor(item)) {
      if (!await isProviderOnline(tx, p)) continue;

      const status = await getProviderStatus(tx, orderId, item, p);
      if (status === "ready" && !readyProvider) {
        readyProvider = p;
      } else if (!status || status === "rejected") {
        markSubmitted(tx, orderId, item, p);
        toSubmit.push(p);
      }
    }

    if (readyProvider) {
      ready.push({ item, provider: readyProvider });
    } else {
      allReady = false;
      if (toSubmit.length > 0) {
        needsSubmit.push({ item, providers: toSubmit });
      }
    }
  }

  // ALL items have a ready provider → confirm them all
  if (allReady && ready.length === items.length) {
    return { action: "confirm", winners: ready };
  }

  // Some items need new submissions
  if (needsSubmit.length > 0) {
    return { action: "submit", submissions: needsSubmit };
  }

  // Everything is submitted, waiting for responses
  return { action: "wait" };
}

// ═══════════════════════════════════════════════════════════════════════
//  Place an order
// ═══════════════════════════════════════════════════════════════════════

export const placeOrder = mutation({
  args: { items: v.array(v.string()), timeoutMs: v.optional(v.number()) },
  handler: async (ctx, { items, timeoutMs }) => {
    const orderId = await ctx.db.insert("orders", {
      items, status: "pending", attempts: [],
    });

    for (const item of items) {
      for (const p of providersFor(item)) {
        await stm.init(ctx, `order:${orderId}:${item}:${p}`, null);
      }
    }

    if (timeoutMs) {
      await ctx.scheduler.runAfter(timeoutMs, internal.example.expireOrder, {
        orderId: orderId as string, items: JSON.stringify(items),
      });
    }

    await runFulfillment(ctx, orderId, items);
    return orderId;
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Run fulfillment
// ═══════════════════════════════════════════════════════════════════════

async function runFulfillment(ctx: any, orderId: any, items: string[]) {
  const order = await ctx.db.get(orderId);
  if (!order || order.status === "fulfilled" || order.status === "expired") return;

  const result = await stm.atomic(
    ctx,
    async (tx: TX) => await fulfillCart(tx, orderId, items),
  );

  if (!result.committed) {
    if (order.status === "submitted") {
      await ctx.db.patch(orderId, { status: "pending" });
    }
    return;
  }

  const plan = result.value;

  if (plan.action === "confirm") {
    // ALL items ready — confirm every winner via HTTP, then mark fulfilled
    const assignments: Record<string, string> = {};
    for (const w of plan.winners) assignments[w.item] = w.provider;
    await ctx.db.patch(orderId, { status: "submitted" });

    // Schedule the confirm action (does fetch to each provider)
    await ctx.scheduler.runAfter(0, internal.providerAction.confirmAll, {
      orderId: orderId as string,
      items: JSON.stringify(items),
      winners: JSON.stringify(plan.winners),
    });
  } else if (plan.action === "submit") {
    await ctx.db.patch(orderId, { status: "submitted" });
    for (const sub of plan.submissions) {
      for (const provider of sub.providers) {
        await ctx.scheduler.runAfter(0, internal.providerAction.submitToProvider, {
          orderId: orderId as string,
          items: JSON.stringify(items),
          item: sub.item,
          provider,
        });
      }
    }
  }
  // "wait" → do nothing, providers are processing
}

// ═══════════════════════════════════════════════════════════════════════
//  Webhook — provider says "ready" or "rejected"
// ═══════════════════════════════════════════════════════════════════════

export const handleWebhook = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string(), result: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider, result }) => {
    const order = await ctx.db.get(orderId as any);
    if (!order || order.status === "fulfilled" || order.status === "expired") return;

    // Write the provider's response to the TVar
    await ctx.runMutation(components.stm.lib.commit, {
      writes: [{ key: `order:${orderId}:${item}:${provider}`, value: result }],
    });

    // Record attempt
    await ctx.db.patch(order._id, {
      attempts: [...order.attempts, { item, provider, result, at: Date.now() }],
    });

    // Re-run fulfillment — might now have all items ready
    const items: string[] = JSON.parse(itemsJson);
    await runFulfillment(ctx, orderId as any, items);
  },
});

// Called after all winners are confirmed via HTTP
export const markFulfilled = internalMutation({
  args: { orderId: v.string(), winners: v.string() },
  handler: async (ctx, { orderId, winners: winnersJson }) => {
    const order = await ctx.db.get(orderId as any);
    if (!order || order.status === "fulfilled" || order.status === "expired") return;

    const winners: { item: string; provider: string }[] = JSON.parse(winnersJson);
    const assignments: Record<string, string> = {};
    for (const w of winners) assignments[w.item] = w.provider;

    await ctx.db.patch(order._id, { status: "fulfilled", assignments });

    // Record confirmations
    for (const w of winners) {
      await ctx.db.patch(order._id, {
        attempts: [
          ...(await ctx.db.get(order._id))!.attempts,
          { item: w.item, provider: w.provider, result: "confirmed", at: Date.now() },
        ],
      });
    }
  },
});

export const retryFulfillment = internalMutation({
  args: { orderId: v.string(), items: v.string() },
  handler: async (ctx, { orderId, items: itemsJson }) => {
    await runFulfillment(ctx, orderId as any, JSON.parse(itemsJson));
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Order expiry — cancel everything
// ═══════════════════════════════════════════════════════════════════════

export const expireOrder = internalMutation({
  args: { orderId: v.string(), items: v.string() },
  handler: async (ctx, { orderId, items: itemsJson }) => {
    const order = await ctx.db.get(orderId as any);
    if (!order || order.status === "fulfilled") return;

    await ctx.db.patch(order._id, { status: "expired" as any });

    // Cancel all "ready" providers via HTTP
    const items: string[] = JSON.parse(itemsJson);
    const readyProviders: { item: string; provider: string }[] = [];
    for (const item of items) {
      for (const p of providersFor(item)) {
        const status = await ctx.runQuery(components.stm.lib.readTVar, {
          key: `order:${orderId}:${item}:${p}`,
        });
        if (status === "ready") {
          readyProviders.push({ item, provider: p });
        }
      }
    }

    if (readyProviders.length > 0) {
      await ctx.scheduler.runAfter(0, internal.providerAction.cancelAll, {
        orderId, providers: JSON.stringify(readyProviders),
      });
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Webhook HTTP endpoint
// ═══════════════════════════════════════════════════════════════════════

export const webhookHandler = httpAction(async (ctx, request) => {
  const body = (await request.json()) as {
    orderId: string; items: string; item: string; provider: string; result: string;
  };

  await ctx.runMutation(internal.example.handleWebhook, {
    orderId: body.orderId, items: body.items, item: body.item,
    provider: body.provider, result: body.result,
  });

  return new Response(JSON.stringify({ status: "received" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Provider availability
// ═══════════════════════════════════════════════════════════════════════

export const toggleProvider = mutation({
  args: { provider: v.string() },
  handler: async (ctx, { provider }) => {
    let turningOn = false;
    await stm.atomic(ctx, async (tx) => {
      const current = await isProviderOnline(tx, provider);
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
                const s = await getProviderStatus(tx, o._id, item, provider);
                if (s === "rejected") tx.write(`order:${o._id}:${item}:${provider}`, null);
              });
            }
          }
          await runFulfillment(ctx, o._id, o.items);
        }
      }
    }
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
                const s = await getProviderStatus(tx, o._id, item, provider);
                if (s === "rejected") tx.write(`order:${o._id}:${item}:${provider}`, null);
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
      writes: PROVIDERS.map((p) => ({ key: `provider:${p}:available`, value: true })),
    });
    await ctx.runMutation(internal.mockProviders.settings.initAll, {});
    const orders = await ctx.db.query("orders").collect();
    for (const o of orders) await ctx.db.delete(o._id);
  },
});

export const readProviders = query({
  args: {},
  handler: async (ctx) => {
    const allSettings = await ctx.db.query("providerSettings").collect();
    const settingsMap: Record<string, { failRate: number; maxDelay: number }> = {};
    for (const s of allSettings) settingsMap[s.provider] = { failRate: s.failRate, maxDelay: s.maxDelay };

    const result: Record<string, { available: boolean; products: string[]; failRate: number; maxDelay: number }> = {};
    for (const p of PROVIDERS) {
      const s = settingsMap[p] ?? { failRate: 30, maxDelay: 5000 };
      result[p] = {
        available: ((await ctx.runQuery(components.stm.lib.readTVar, { key: `provider:${p}:available` })) as boolean) ?? false,
        products: CATALOG[p],
        failRate: s.failRate,
        maxDelay: s.maxDelay,
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
