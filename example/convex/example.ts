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
//  Step 1: STM transaction — pick providers, no IO
// ═══════════════════════════════════════════════════════════════════════

// Try to claim an item from a provider. Pure logic, no side effects.
async function claimFrom(tx: TX, orderId: string, item: string, provider: string) {
  // Is this provider online?
  const online = await tx.read(`provider:${provider}:online`);
  if (!online) tx.retry();

  // Have we already tried this provider for this item?
  const status = await tx.read(`${orderId}:${item}:${provider}`);
  if (status === "submitted") tx.retry();  // waiting for response
  if (status === "accepted") return provider;  // already won
  if (status === "rejected") tx.retry();  // failed, try next

  // Not tried yet — mark as submitted
  tx.write(`${orderId}:${item}:${provider}`, "submitted");
  return provider;
}

// For each item in the cart, race all capable providers.
// Returns the list of items that need provider API calls.
async function fillOrder(tx: TX, orderId: string, items: string[]) {
  const toSubmit: { item: string; provider: string }[] = [];
  let allDone = true;

  for (const item of items) {
    // Check if any provider already accepted this item
    let found = false;
    for (const p of providersFor(item)) {
      const status = await tx.read(`${orderId}:${item}:${p}`);
      if (status === "accepted") { found = true; break; }
    }
    if (found) continue;

    allDone = false;
    // Submit to all available providers at once
    for (const p of providersFor(item)) {
      const online = await tx.read(`provider:${p}:online`);
      if (!online) continue;
      const status = await tx.read(`${orderId}:${item}:${p}`);
      if (!status || status === "rejected") {
        tx.write(`${orderId}:${item}:${p}`, "submitted");
        toSubmit.push({ item, provider: p });
      }
    }
  }

  return { done: allDone, toSubmit };
}

// ═══════════════════════════════════════════════════════════════════════
//  Step 2: Action — call provider API (IO)
//  (in providerAction.ts — actions can't share module with components)
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
//  Step 3: Webhook — provider responds, STM records it
// ═══════════════════════════════════════════════════════════════════════

export const handleWebhook = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string(), result: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider, result }) => {
    const order = await ctx.db.get(orderId as any);
    if (!order || order.status === "fulfilled" || order.status === "expired") return;

    // Record the provider's response (writes the TVar)
    await ctx.runMutation(components.stm.lib.commit, {
      writes: [{ key: `${orderId}:${item}:${provider}`, value: result }],
    });

    // Log the attempt for the UI
    await ctx.db.patch(order._id, {
      attempts: [...order.attempts, { item, provider, result, at: Date.now() }],
    });

    // Re-run the order — maybe it's complete now
    await runOrder(ctx, orderId as any, JSON.parse(itemsJson));
  },
});

export const webhookHandler = httpAction(async (ctx, request) => {
  const body = (await request.json()) as {
    orderId: string; items: string; item: string; provider: string; result: string;
  };
  await ctx.runMutation(internal.example.handleWebhook, body);
  return new Response("OK", { status: 200 });
});

// ═══════════════════════════════════════════════════════════════════════
//  Order lifecycle
// ═══════════════════════════════════════════════════════════════════════

export const placeOrder = mutation({
  args: { items: v.array(v.string()), timeoutMs: v.optional(v.number()) },
  handler: async (ctx, { items, timeoutMs }) => {
    const orderId = await ctx.db.insert("orders", {
      items, status: "pending", attempts: [],
    });

    // Init per-item-per-provider TVars
    for (const item of items) {
      for (const p of providersFor(item)) {
        await stm.init(ctx, `${orderId}:${item}:${p}`, null);
      }
    }

    if (timeoutMs) {
      await ctx.scheduler.runAfter(timeoutMs, internal.example.expireOrder, {
        orderId: orderId as string,
      });
    }

    await runOrder(ctx, orderId, items);
    return orderId;
  },
});

async function runOrder(ctx: any, orderId: any, items: string[]) {
  const order = await ctx.db.get(orderId);
  if (!order || order.status === "fulfilled" || order.status === "expired") return;

  const result = await stm.atomic(ctx, async (tx: TX) => fillOrder(tx, orderId, items));
  if (!result.committed) return;

  const { done, toSubmit } = result.value;

  if (done) {
    // All items have an accepted provider — order complete
    const assignments: Record<string, string> = {};
    for (const item of items) {
      for (const p of providersFor(item)) {
        const status = await ctx.runQuery(components.stm.lib.readTVar, {
          key: `${orderId}:${item}:${p}`,
        });
        if (status === "accepted") { assignments[item] = p; break; }
      }
    }
    await ctx.db.patch(orderId, { status: "fulfilled", assignments });
  } else {
    await ctx.db.patch(orderId, { status: "submitted" });
    // Step 2: call provider APIs (IO happens here, not in the transaction)
    for (const { item, provider } of toSubmit) {
      await ctx.scheduler.runAfter(0, internal.providerAction.submitToProvider, {
        orderId: orderId as string,
        items: JSON.stringify(items),
        item,
        provider,
      });
    }
  }
}

export const retryOrder = internalMutation({
  args: { orderId: v.string(), items: v.string() },
  handler: async (ctx, { orderId, items }) => {
    await runOrder(ctx, orderId as any, JSON.parse(items));
  },
});

export const expireOrder = internalMutation({
  args: { orderId: v.string() },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId as any);
    if (!order || order.status === "fulfilled") return;
    await ctx.db.patch(order._id, { status: "expired" as any });
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Provider on/off (TVar — STM uses this for routing)
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
        if (o.status === "pending" || o.status === "submitted") {
          await runOrder(ctx, o._id, o.items);
        }
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
        if (o.status === "pending" || o.status === "submitted") {
          await runOrder(ctx, o._id, o.items);
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
