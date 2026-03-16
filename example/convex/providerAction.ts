import { internalAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";

const SITE_URL = process.env.CONVEX_SITE_URL!;

// ═══════════════════════════════════════════════════════════════════════
//  Phase 1: Submit order to provider → they webhook back "ready"/"rejected"
// ═══════════════════════════════════════════════════════════════════════

export const submitToProvider = internalAction({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string() },
  handler: async (_ctx, { orderId, items, item, provider }) => {
    await fetch(`${SITE_URL}/mock/${provider}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId, item, items,
        callbackUrl: `${SITE_URL}/webhook/provider`,
      }),
    });
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Phase 2: Confirm all winners — called when entire cart is ready
// ═══════════════════════════════════════════════════════════════════════
//  This is the actual commit. We tell each winning provider "go ahead
//  and print it." Their 200 response means it's confirmed.

export const confirmAll = internalAction({
  args: { orderId: v.string(), items: v.string(), winners: v.string() },
  handler: async (ctx, { orderId, items, winners: winnersJson }) => {
    const winners: { item: string; provider: string }[] = JSON.parse(winnersJson);

    // Confirm each winner via HTTP
    const results = await Promise.allSettled(
      winners.map(async ({ item, provider }) => {
        const res = await fetch(`${SITE_URL}/mock/${provider}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId, item, action: "CONFIRM" }),
        });
        return { item, provider, ok: res.ok };
      }),
    );

    // All confirmed → mark fulfilled
    const allOk = results.every(
      (r) => r.status === "fulfilled" && r.value.ok,
    );

    if (allOk) {
      await ctx.runMutation(internal.example.markFulfilled, {
        orderId, winners: winnersJson,
      });
    }
    // If any failed, we'd need retry logic here. For the demo, assume success.
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Cancel — called on order expiry. Tell "ready" providers to stand down.
// ═══════════════════════════════════════════════════════════════════════

export const cancelAll = internalAction({
  args: { orderId: v.string(), providers: v.string() },
  handler: async (_ctx, { orderId, providers: providersJson }) => {
    const providers: { item: string; provider: string }[] = JSON.parse(providersJson);

    await Promise.allSettled(
      providers.map(async ({ item, provider }) => {
        await fetch(`${SITE_URL}/mock/${provider}/confirm`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId, item, action: "CANCEL" }),
        });
      }),
    );
  },
});
