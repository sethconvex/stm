import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  orders: defineTable({
    design: v.string(),
    size: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("submitted"),
      v.literal("fulfilled"),
      v.literal("failed"),
    ),
    provider: v.optional(v.string()),
    attempts: v.array(
      v.object({
        provider: v.string(),
        result: v.string(),
        at: v.number(),
      }),
    ),
  }),
});
