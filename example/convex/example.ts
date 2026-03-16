import { mutation, query, internalMutation, httpAction } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

// ═══════════════════════════════════════════════════════════════════════
//  Catalog: who makes what
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
//  Domain helpers — readable operations on order state
// ═══════════════════════════════════════════════════════════════════════
//  These hide the TVar keys. Developers think in terms of
//  "is this provider available?" not "tx.read(`provider:${p}:available`)"

async function isProviderOnline(tx: TX, provider: string) {
  return (await tx.read(`provider:${provider}:available`)) === true;
}

async function getWinner(tx: TX, orderId: string, item: string) {
  return (await tx.read(`order:${orderId}:${item}:winner`)) as string | null;
}

async function setWinner(tx: TX, orderId: string, item: string, provider: string) {
  tx.write(`order:${orderId}:${item}:winner`, provider);
  tx.write(`order:${orderId}:${item}:${provider}`, "accepted");
}

async function getProviderStatus(tx: TX, orderId: string, item: string, provider: string) {
  return (await tx.read(`order:${orderId}:${item}:${provider}`)) as string | null;
}

function markSubmitted(tx: TX, orderId: string, item: string, provider: string) {
  tx.write(`order:${orderId}:${item}:${provider}`, "submitted");
}

function markCanceled(tx: TX, orderId: string, item: string, provider: string) {
  tx.write(`order:${orderId}:${item}:${provider}`, "canceled");
}

// ═══════════════════════════════════════════════════════════════════════
//  Fulfillment logic — submit all items to all providers at once
// ═══════════════════════════════════════════════════════════════════════

async function fulfillCart(tx: TX, orderId: string, items: string[]) {
  const plan: { next: "done" | "submit"; item: string; provider?: string; providers?: string[] }[] = [];
  let allDone = true;

  for (const item of items) {
    const winner = await getWinner(tx, orderId, item);
    if (winner) {
      plan.push({ next: "done", item, provider: winner });
      continue;
    }

    allDone = false;
    const toSubmit: string[] = [];

    for (const p of providersFor(item)) {
      if (!await isProviderOnline(tx, p)) continue;

      const status = await getProviderStatus(tx, orderId, item, p);
      if (!status || status === "rejected" || status === "canceled") {
        markSubmitted(tx, orderId, item, p);
        toSubmit.push(p);
      }
    }

    if (toSubmit.length > 0) {
      plan.push({ next: "submit", item, providers: toSubmit });
    }
  }

  return plan;
}

// ═══════════════════════════════════════════════════════════════════════
//  Confirm or cancel — atomic winner selection
// ═══════════════════════════════════════════════════════════════════════
//  First provider to respond "ready" wins. Everyone else gets canceled.
//  Idempotent: same answer no matter how many times you call it.

async function confirmOrCancelProvider(
  tx: TX, orderId: string, item: string, provider: string,
): Promise<"CONFIRM" | "CANCEL"> {
  const winner = await getWinner(tx, orderId, item);
  if (winner === provider) return "CONFIRM";  // you already won
  if (winner) {
    markCanceled(tx, orderId, item, provider);
    return "CANCEL";                          // someone else won
  }
  await setWinner(tx, orderId, item, provider);
  return "CONFIRM";                           // you're first!
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

    // Init TVars for each item × provider + winner per item
    for (const item of items) {
      await stm.init(ctx, `order:${orderId}:${item}:winner`, null);
      for (const p of providersFor(item)) {
        await stm.init(ctx, `order:${orderId}:${item}:${p}`, null);
      }
    }

    // Optional order-level timeout: if not ALL items are fulfilled
    // within timeoutMs, cancel the entire order. Atomic guarantee.
    if (timeoutMs) {
      await ctx.scheduler.runAfter(timeoutMs, internal.example.expireOrder, {
        orderId: orderId as string,
      });
    }

    await runFulfillment(ctx, orderId, items);
    return orderId;
  },
});

// If the order isn't fulfilled by the deadline, cancel everything.
export const expireOrder = internalMutation({
  args: { orderId: v.string() },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId as any);
    if (!order || order.status === "fulfilled" || order.status === "expired") return; // already done
    await ctx.db.patch(order._id, { status: "expired" as any });
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Run fulfillment — dispatch provider requests
// ═══════════════════════════════════════════════════════════════════════

async function runFulfillment(ctx: any, orderId: any, items: string[]) {
  const order = await ctx.db.get(orderId);
  if (!order || order.status === "fulfilled" || order.status === "expired") return;

  const result = await stm.atomic(
    ctx,
    async (tx: TX) => await fulfillCart(tx, orderId, items),
  );

  if (result.committed) {
    const plan = result.value;
    const allDone = items.every((item) =>
      plan.some((p: any) => p.item === item && p.next === "done"),
    );

    if (allDone) {
      const assignments: Record<string, string> = {};
      for (const p of plan) if (p.provider) assignments[p.item] = p.provider;
      await ctx.db.patch(orderId, { status: "fulfilled", assignments });
    } else {
      await ctx.db.patch(orderId, { status: "submitted" });
      for (const step of plan) {
        if (step.next === "submit" && step.providers) {
          for (const provider of step.providers) {
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
//  Webhook handlers — called when a provider responds
// ═══════════════════════════════════════════════════════════════════════

export const confirmOrCancel = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider }) => {
    // Atomic winner selection using component API directly
    // (Can't use stm.atomic here because this is called from action chain)
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

    // Record attempt
    const order = await ctx.db.get(orderId as any);
    if (order) {
      await ctx.db.patch(order._id, {
        attempts: [
          ...order.attempts,
          { item, provider, result: decision === "CONFIRM" ? "accepted" : "canceled", at: Date.now() },
        ],
      });
    }

    await ctx.scheduler.runAfter(0, internal.example.retryFulfillment, {
      orderId, items: itemsJson,
    });
  },
});

export const handleResponse = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string(), result: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider, result }) => {
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

export const retryFulfillment = internalMutation({
  args: { orderId: v.string(), items: v.string() },
  handler: async (ctx, { orderId, items: itemsJson }) => {
    await runFulfillment(ctx, orderId as any, JSON.parse(itemsJson));
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Webhook HTTP endpoint
// ═══════════════════════════════════════════════════════════════════════

export const webhookHandler = httpAction(async (ctx, request) => {
  const body = (await request.json()) as {
    orderId: string; items: string; item: string; provider: string; result: string;
  };

  if (body.result === "ready") {
    await ctx.runMutation(internal.example.confirmOrCancel, {
      orderId: body.orderId, items: body.items, item: body.item, provider: body.provider,
    });
  } else {
    await ctx.runMutation(internal.example.handleResponse, {
      orderId: body.orderId, items: body.items, item: body.item,
      provider: body.provider, result: body.result,
    });
  }

  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Provider availability (STM TVar — used for order routing)
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
                if (s === "rejected" || s === "canceled")
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
                if (s === "rejected" || s === "canceled")
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
