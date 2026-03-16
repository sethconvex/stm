import { mutation, query, internalMutation, internalAction, httpAction } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

// ═══════════════════════════════════════════════════════════════════════
//  Product catalog — each provider makes different products
// ═══════════════════════════════════════════════════════════════════════

const PROVIDERS = ["printful", "printify", "gooten"] as const;
const PRODUCTS = ["shirt", "mug", "poster"] as const;

// Who makes what:
//   Printful:  shirt, mug
//   Printify:  shirt, poster
//   Gooten:    mug, poster
// No single provider makes all three.
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
//  Building block: try one provider for one item
// ═══════════════════════════════════════════════════════════════════════

async function tryProvider(tx: TX, orderId: string, item: string, provider: string) {
  const available = await tx.read(`provider:${provider}:available`);
  if (!available) tx.retry();

  const key = `order:${orderId}:${item}:${provider}`;
  const result = await tx.read(key);

  if (result === null || result === "retry") {
    tx.write(key, "submitted");
    return { next: "submit" as const, item, provider };
  }
  if (result === "submitted") tx.retry();
  if (result === "accepted") return { next: "done" as const, item, provider };
  tx.retry(); // rejected
}

// ═══════════════════════════════════════════════════════════════════════
//  Fulfill a cart — each item selects from its capable providers
//  ALL items must succeed. If any blocks, the whole cart waits.
// ═══════════════════════════════════════════════════════════════════════

async function fulfillCart(tx: TX, orderId: string, items: string[]) {
  const plan: { next: "submit" | "done"; item: string; provider: string }[] = [];

  for (const item of items) {
    const providers = providersFor(item);
    const result = await tx.select(
      ...providers.map((p) => async () => await tryProvider(tx, orderId, item, p)),
    );
    plan.push(result);
  }

  return plan;
}

// ═══════════════════════════════════════════════════════════════════════
//  Place an order with multiple items
// ═══════════════════════════════════════════════════════════════════════

export const placeOrder = mutation({
  args: { items: v.array(v.string()) },
  handler: async (ctx, { items }) => {
    const orderId = await ctx.db.insert("orders", {
      items,
      status: "pending",
      attempts: [],
    });

    // Init TVars for each item × provider combination
    for (const item of items) {
      for (const p of providersFor(item)) {
        await stm.init(ctx, `order:${orderId}:${item}:${p}`, null);
      }
    }

    await runFulfillment(ctx, orderId, items);
    return orderId;
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Core fulfillment — runs the cart transaction, dispatches actions
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
    const needsSubmit = plan.filter((p) => p.next === "submit");
    const allDone = plan.every((p) => p.next === "done");

    if (allDone) {
      // Every item has an accepted provider — order is fulfilled!
      const assignments: Record<string, string> = {};
      for (const p of plan) assignments[p.item] = p.provider;
      await ctx.db.patch(orderId, { status: "fulfilled", assignments });
    } else {
      // Some items need to be submitted to providers
      await ctx.db.patch(orderId, { status: "submitted" });
      for (const s of needsSubmit) {
        await ctx.scheduler.runAfter(0, internal.example.submitToProvider, {
          orderId: orderId as string,
          items: JSON.stringify(items),
          item: s.item,
          provider: s.provider,
        });
      }
    }
  } else {
    // Blocked — all providers for some item are unavailable/rejected.
    // Order stays pending. Waiter will wake when state changes.
    if (order.status === "submitted") {
      await ctx.db.patch(orderId, { status: "pending" });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Submit one item to one provider
// ═══════════════════════════════════════════════════════════════════════

export const submitToProvider = internalAction({
  args: {
    orderId: v.string(),
    items: v.string(), // JSON stringified items array
    item: v.string(),
    provider: v.string(),
  },
  handler: async (ctx, { orderId, items, item, provider }) => {
    // Simulate provider API (1-3s, 70% acceptance)
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 2000));
    const result = Math.random() < 0.7 ? "accepted" : "rejected";

    await ctx.runMutation(internal.example.handleAndRetry, {
      orderId,
      items,
      item,
      provider,
      result,
    });
  },
});

export const handleAndRetry = internalMutation({
  args: {
    orderId: v.string(),
    items: v.string(),
    item: v.string(),
    provider: v.string(),
    result: v.string(),
  },
  handler: async (ctx, { orderId, items: itemsJson, item, provider, result }) => {
    const items: string[] = JSON.parse(itemsJson);

    // Write the result TVar
    await stm.atomic(ctx, async (tx) => {
      tx.write(`order:${orderId}:${item}:${provider}`, result);
    });

    // Record attempt
    const order = await ctx.db.get(orderId as any);
    if (order) {
      await ctx.db.patch(order._id, {
        attempts: [...order.attempts, { item, provider, result, at: Date.now() }],
      });
    }

    // Re-run fulfillment for the whole cart
    await runFulfillment(ctx, orderId as any, items);
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Webhook
// ═══════════════════════════════════════════════════════════════════════

export const webhookHandler = httpAction(async (ctx, request) => {
  const body = await request.json() as {
    orderId: string; items: string; item: string; provider: string; result: string;
  };
  await ctx.runMutation(internal.example.handleAndRetry, body);
  return new Response("OK", { status: 200 });
});

// ═══════════════════════════════════════════════════════════════════════
//  Toggle provider
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
          // Reset rejections for this provider on all items
          for (const item of o.items) {
            if (providersFor(item).includes(provider)) {
              await stm.atomic(ctx, async (tx) => {
                const r = await tx.read(`order:${o._id}:${item}:${provider}`);
                if (r === "rejected") tx.write(`order:${o._id}:${item}:${provider}`, "retry");
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
      writes: PROVIDERS.map((p) => ({
        key: `provider:${p}:available`,
        value: true,
      })),
    });
    const orders = await ctx.db.query("orders").collect();
    for (const o of orders) await ctx.db.delete(o._id);
  },
});

export const readProviders = query({
  args: {},
  handler: async (ctx) => {
    const result: Record<string, { available: boolean; products: string[] }> = {};
    for (const p of PROVIDERS) {
      result[p] = {
        available: ((await ctx.runQuery(components.stm.lib.readTVar, {
          key: `provider:${p}:available`,
        })) as boolean) ?? false,
        products: CATALOG[p],
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
