import { internalAction } from "./_generated/server.js";
import { internal } from "./_generated/api.js";
import { v } from "convex/values";

// This is in a separate file because actions load modules differently
// from mutations, and the STM component API (components.stm) causes
// issues when loaded in an action context.

export const submitToProvider = internalAction({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string() },
  handler: async (ctx, { orderId, items, item, provider }) => {
    // Simulate provider API (1-5s, we don't control this)
    await new Promise((r) => setTimeout(r, 1000 + Math.random() * 4000));

    // 70% acceptance
    const canFulfill = Math.random() < 0.7;

    if (canFulfill) {
      await ctx.runMutation(internal.example.confirmOrCancel, {
        orderId, items, item, provider,
      });
    } else {
      await ctx.runMutation(internal.example.handleResponse, {
        orderId, items, item, provider, result: "rejected",
      });
    }
  },
});
