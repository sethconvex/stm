import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // Transactional variables.
  // Each TVar is a named cell holding a serializable value.
  tvars: defineTable({
    key: v.string(),
    value: v.any(),
  }).index("by_key", ["key"]),

  // Waiters: blocked callers waiting for a TVar to change.
  // Inserted on retry(), deleted + woken by the trigger on tvars writes.
  waiters: defineTable({
    tvarKey: v.string(),
    callbackHandle: v.string(),
    callbackArgs: v.optional(v.any()),
  })
    .index("by_tvar", ["tvarKey"])
    .index("by_callback", ["callbackHandle"]),
});
