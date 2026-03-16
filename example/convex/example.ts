import { mutation, query, internalMutation, internalAction, httpAction } from "./_generated/server.js";
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
// providers have been submitted. If not, submit them all. Then wait.
async function raceProviders(tx: TX, orderId: string, item: string) {
  const providers = providersFor(item);

  // Do we already have a winner?
  const winner = await tx.read(`order:${orderId}:${item}:winner`);
  if (winner) return { next: "done" as const, item, provider: winner as string };

  // Submit to ALL capable providers simultaneously
  const toSubmit: string[] = [];
  let anyPending = false;
  for (const p of providers) {
    const available = await tx.read(`provider:${p}:available`);
    if (!available) continue;

    const status = await tx.read(`order:${orderId}:${item}:${p}`);
    if (status === null || status === "rejected" || status === "canceled") {
      // Not yet submitted, or previously rejected — (re)submit
      tx.write(`order:${orderId}:${item}:${p}`, "submitted");
      toSubmit.push(p);
    } else if (status === "submitted") {
      anyPending = true; // still waiting on this one
    }
  }

  if (toSubmit.length > 0) {
    return { next: "submit-all" as const, item, providers: toSubmit };
  }

  if (anyPending) {
    // Some providers still processing — wait for response
    tx.retry();
  }

  // All available providers rejected and none pending — wait for a
  // provider to come back online (availability TVar is in read set)
  tx.retry();
}

async function fulfillCart(tx: TX, orderId: string, items: string[]) {
  const plan: any[] = [];
  for (const item of items) {
    plan.push(await raceProviders(tx, orderId, item));
  }
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
    const allDone = plan.every((p: any) => p.next === "done");

    if (allDone) {
      const assignments: Record<string, string> = {};
      for (const p of plan) assignments[p.item] = p.provider;
      await ctx.db.patch(orderId, { status: "fulfilled", assignments });
    } else {
      await ctx.db.patch(orderId, { status: "submitted" });
      // Dispatch actions for ALL providers that need submitting
      for (const step of plan) {
        if (step.next === "submit-all") {
          for (const provider of step.providers) {
            await ctx.scheduler.runAfter(0, internal.example.submitToProvider, {
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
//  Submit to provider — simulates the API call
// ═══════════════════════════════════════════════════════════════════════

export const submitToProvider = internalAction({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string() },
  handler: async (ctx, { orderId, items, item, provider }) => {
    const failRate = ((await ctx.runQuery(components.stm.lib.readTVar, {
      key: `provider:${provider}:failRate`,
    })) as number) ?? 30;

    // Simulate provider API (1-5s, we don't control this)
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 4000));

    // Check we haven't been superseded
    const current = await ctx.runQuery(components.stm.lib.readTVar, {
      key: `order:${orderId}:${item}:${provider}`,
    });
    if (current !== "submitted") return;

    // Provider says "I can do this" or "nope"
    const canFulfill = Math.random() * 100 >= failRate;

    if (canFulfill) {
      // Provider is ready — ask us to confirm (like a webhook saying "ready")
      await ctx.runMutation(internal.example.confirmOrCancel, {
        orderId, items, item, provider,
      });
    } else {
      // Provider rejects outright
      await ctx.runMutation(internal.example.handleResponse, {
        orderId, items, item, provider, result: "rejected",
      });
    }
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  CONFIRM or CANCEL — the atomic winner selection
// ═══════════════════════════════════════════════════════════════════════
//  First provider to call this wins. Others get canceled.
//  Idempotent: calling twice returns the same answer.

export const confirmOrCancel = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider }) => {
    const items: string[] = JSON.parse(itemsJson);

    let decision = "";

    await stm.atomic(ctx, async (tx) => {
      const winner = await tx.read(`order:${orderId}:${item}:winner`);

      if (winner === provider) {
        decision = "CONFIRM"; // You already won, yes again
        return;
      }
      if (winner) {
        decision = "CANCEL"; // Someone else won
        tx.write(`order:${orderId}:${item}:${provider}`, "canceled");
        return;
      }

      // You're first — you win!
      decision = "CONFIRM";
      tx.write(`order:${orderId}:${item}:winner`, provider);
      tx.write(`order:${orderId}:${item}:${provider}`, "accepted");
    });

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

    // Re-run fulfillment (might complete the order now)
    await runFulfillment(ctx, orderId as any, items);
  },
});

// Handle outright rejection (not a race — provider said no)
export const handleResponse = internalMutation({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string(), result: v.string() },
  handler: async (ctx, { orderId, items: itemsJson, item, provider, result }) => {
    const items: string[] = JSON.parse(itemsJson);

    await stm.atomic(ctx, async (tx) => {
      tx.write(`order:${orderId}:${item}:${provider}`, result);
    });

    const order = await ctx.db.get(orderId as any);
    if (order) {
      await ctx.db.patch(order._id, {
        attempts: [...order.attempts, { item, provider, result, at: Date.now() }],
      });
    }

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
