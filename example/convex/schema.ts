import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  orders: defineTable({
    items: v.array(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("submitted"),
      v.literal("fulfilled"),
    ),
    // Which provider is fulfilling each item: { "shirt": "printful", "mug": "gooten" }
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
});
