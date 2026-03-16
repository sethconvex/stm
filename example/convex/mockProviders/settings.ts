import { mutation, query, internalQuery } from "../_generated/server.js";
import { v } from "convex/values";

// ═══════════════════════════════════════════════════════════════════════
//  Provider settings — plain Convex queries and mutations
//  These belong to the mock providers, not to the STM system.
// ═══════════════════════════════════════════════════════════════════════

export const get = internalQuery({
  args: { provider: v.string() },
  handler: async (ctx, { provider }) => {
    return await ctx.db
      .query("providerSettings")
      .withIndex("by_provider", (q) => q.eq("provider", provider))
      .unique();
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("providerSettings").collect();
    const result: Record<string, { failRate: number; maxDelay: number }> = {};
    for (const r of rows) {
      result[r.provider] = { failRate: r.failRate, maxDelay: r.maxDelay };
    }
    return result;
  },
});

export const set = mutation({
  args: { provider: v.string(), failRate: v.optional(v.number()), maxDelay: v.optional(v.number()) },
  handler: async (ctx, { provider, failRate, maxDelay }) => {
    const existing = await ctx.db
      .query("providerSettings")
      .withIndex("by_provider", (q) => q.eq("provider", provider))
      .unique();
    if (existing) {
      const patch: any = {};
      if (failRate !== undefined) patch.failRate = failRate;
      if (maxDelay !== undefined) patch.maxDelay = maxDelay;
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("providerSettings", {
        provider,
        failRate: failRate ?? 30,
        maxDelay: maxDelay ?? 5000,
      });
    }
  },
});

export const initAll = mutation({
  args: {},
  handler: async (ctx) => {
    const existing = await ctx.db.query("providerSettings").collect();
    for (const r of existing) await ctx.db.delete(r._id);
    for (const p of ["printful", "printify", "gooten"]) {
      await ctx.db.insert("providerSettings", {
        provider: p,
        failRate: 30,
        maxDelay: 5000,
      });
    }
  },
});
