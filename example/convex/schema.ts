import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  orders: defineTable({
    items: v.array(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("submitted"),
      v.literal("fulfilled"),
      v.literal("expired"),
    ),
    timeoutMs: v.optional(v.number()),
    assignments: v.optional(v.any()),
    attempts: v.array(
      v.object({
        item: v.string(),
        provider: v.string(),
        result: v.string(),
        at: v.number(),
      }),
    ),
  }),

  // Mock provider settings — NOT TVars. These belong to the "external"
  // providers, not to the STM system. In production these would be in
  // the provider's own database.
  providerSettings: defineTable({
    provider: v.string(),
    failRate: v.number(),   // 0-100
    maxDelay: v.number(),   // ms — max response time
  }).index("by_provider", ["provider"]),
});
