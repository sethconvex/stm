import { mutation, query, internalMutation, httpAction } from "./_generated/server.js";
import { components, internal } from "./_generated/api.js";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";
import type { Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

const stm = new STM(components.stm);

// ═══════════════════════════════════════════════════════════════════════
//  Catalog: who makes what
// ═══════════════════════════════════════════════════════════════════════

const PROVIDERS = ["printful", "printify", "gooten"] as const;
const _PRODUCTS = ["shirt", "mug", "poster"] as const;
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
//  STM building blocks
// ═══════════════════════════════════════════════════════════════════════

// Phase 1: Submit to all providers.
// afterCommit schedules the fetch() calls — they only fire on commit.
async function submitAll(tx: TX, orderId: string, items: string[]) {
  let submitted = false;

  for (const item of items) {
    for (const p of providersFor(item)) {
      const online = await tx.read(`provider:${p}:online`);
      if (!online) continue;
      const status = await tx.read(`${orderId}:${item}:${p}`);
      if (!status || status === "rejected") {
        tx.write(`${orderId}:${item}:${p}`, "submitted");
        submitted = true;

        tx.afterCommit(async (ctx) => {
          await ctx.scheduler.runAfter(0, internal.providerAction.submitToProvider, {
            orderId, items: JSON.stringify(items), item, provider: p,
          });
        });
      }
    }
  }

  return submitted;
}

// Phase 2: Wait for results using select() with timeout.
// Each item picks from its providers — first accepted wins.
async function awaitResults(tx: TX, orderId: string, items: string[], timeoutMs?: number) {
  const assignments: Record<string, string> = {};

  for (const item of items) {
    const winner = await tx.select(
      ...providersFor(item).map((p) => {
        const fn = async () => {
          const status = await tx.read(`${orderId}:${item}:${p}`);
          if (status === "accepted") return p;
          tx.retry();
        };
        return timeoutMs ? { fn, timeout: timeoutMs } : fn;
      }),
    );
    assignments[item] = winner;
  }

  return assignments;
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
        await stm.init(ctx, `${orderId}:${item}:${p}`, null);
      }
    }

    await runOrder(ctx, orderId, items, timeoutMs);
    return orderId;
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Run order — the STM + IO loop
// ═══════════════════════════════════════════════════════════════════════

async function runOrder(ctx: MutationCtx, orderId: Id<"orders">, items: string[], timeoutMs?: number) {
  const order = await ctx.db.get(orderId);
  if (!order || order.status === "fulfilled" || order.status === "expired") return;

  // Phase 1: Submit to all providers (afterCommit dispatches IO)
  const submitResult = await stm.atomic(ctx, async (tx: TX) => submitAll(tx, orderId, items));
  if (submitResult.committed && submitResult.value) {
    await ctx.db.patch(orderId, { status: "submitted" });
  }

  // Phase 2: Wait for results (select with timeout)
  const waitResult = await stm.atomic(ctx, async (tx: TX) => awaitResults(tx, orderId, items, timeoutMs));
  if (waitResult.committed) {
    await ctx.db.patch(orderId, { status: "fulfilled", assignments: waitResult.value });
  } else if (timeoutMs) {
    await ctx.db.patch(orderId, { status: "expired" });
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Webhook — provider responds
// ═══════════════════════════════════════════════════════════════════════

export const handleWebhook = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string(), result: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider, result }) => {
    const order = await ctx.db.get(orderId as Id<"orders">);
    if (!order || order.status === "fulfilled" || order.status === "expired") return;

    // Write the provider's response to the TVar
    await ctx.runMutation(components.stm.lib.commit, {
      writes: [{ key: `${orderId}:${item}:${provider}`, value: result }],
    });

    // Log the attempt
    await ctx.db.patch(order._id, {
      attempts: [...order.attempts, { item, provider, result, at: Date.now() }],
    });

    // Re-run — might be complete now
    const items: string[] = JSON.parse(itemsJson);
    await runOrder(ctx, order._id, items);
  },
});

export const webhookHandler = httpAction(async (ctx, request) => {
  const body = (await request.json()) as {
    orderId: string; items: string; item: string; provider: string; result: string;
  };
  await ctx.runMutation(internal.example.handleWebhook, body);
  return new Response("OK", { status: 200 });
});

export const retryOrder = internalMutation({
  args: { orderId: v.string(), items: v.string() },
  handler: async (ctx, { orderId, items }) => {
    await runOrder(ctx, orderId as Id<"orders">, JSON.parse(items));
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Provider on/off
// ═══════════════════════════════════════════════════════════════════════

export const toggleProvider = mutation({
  args: { provider: v.string() },
  handler: async (ctx, { provider }) => {
    let turningOn = false;
    await stm.atomic(ctx, async (tx) => {
      const current = await tx.read(`provider:${provider}:online`);
      turningOn = !current;
      tx.write(`provider:${provider}:online`, !current);
    });
    if (turningOn) {
      const orders = await ctx.db.query("orders").collect();
      for (const o of orders) {
        if (o.status === "pending" || o.status === "submitted")
          await runOrder(ctx, o._id, o.items);
      }
    }
  },
});

export const setAvailable = mutation({
  args: { provider: v.string(), available: v.boolean() },
  handler: async (ctx, { provider, available }) => {
    await stm.atomic(ctx, async (tx) => {
      tx.write(`provider:${provider}:online`, available);
    });
    if (available) {
      const orders = await ctx.db.query("orders").collect();
      for (const o of orders) {
        if (o.status === "pending" || o.status === "submitted")
          await runOrder(ctx, o._id, o.items);
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
      writes: PROVIDERS.map((p) => ({ key: `provider:${p}:online`, value: true })),
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

    const result: Record<string, { online: boolean; products: string[]; failRate: number; maxDelay: number }> = {};
    for (const p of PROVIDERS) {
      const s = settingsMap[p] ?? { failRate: 30, maxDelay: 5000 };
      result[p] = {
        online: ((await ctx.runQuery(components.stm.lib.readTVar, { key: `provider:${p}:online` })) as boolean) ?? false,
        products: CATALOG[p],
        ...s,
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
