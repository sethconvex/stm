import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Orders that block until stock is available, then auto-complete.
  orders: defineTable({
    item: v.string(),
    amount: v.number(),
    status: v.union(
      v.literal("pending"),
      v.literal("completed"),
      v.literal("failed"),
    ),
    result: v.optional(v.string()),
  }),
});
