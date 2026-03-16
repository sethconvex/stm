import { v } from "convex/values";
import { mutation, query } from "./_generated/server.js";
import type { Id } from "./_generated/dataModel.js";

// ── Reads ──────────────────────────────────────────────────────────────

/**
 * Read a single TVar's current value.
 */
export const readTVar = query({
  args: { key: v.string() },
  returns: v.any(),
  handler: async (ctx, { key }) => {
    const doc = await ctx.db
      .query("tvars")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    return doc?.value ?? null;
  },
});

/**
 * Read multiple TVars in one round-trip.
 */
export const readTVars = query({
  args: { keys: v.array(v.string()) },
  returns: v.any(), // Record<string, any>
  handler: async (ctx, { keys }) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const doc = await ctx.db
        .query("tvars")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      result[key] = doc?.value ?? null;
    }
    return result;
  },
});

// ── Writes (with trigger-based wake) ───────────────────────────────────

/**
 * Commit a batch of TVar writes atomically.
 * For each written TVar, wake all waiters (delete waiter + schedule callback).
 *
 * This is the "trigger" — wake is inline in the same mutation as the write,
 * so it's atomic. No lost wakeups.
 */
export const commit = mutation({
  args: {
    writes: v.array(v.object({ key: v.string(), value: v.any() })),
  },
  returns: v.null(),
  handler: async (ctx, { writes }) => {
    for (const { key, value } of writes) {
      // Upsert the TVar.
      const existing = await ctx.db
        .query("tvars")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      if (existing) {
        await ctx.db.patch(existing._id, { value });
      } else {
        await ctx.db.insert("tvars", { key, value });
      }

      // Wake all waiters on this TVar.
      const waiters = await ctx.db
        .query("waiters")
        .withIndex("by_tvar", (q) => q.eq("tvarKey", key))
        .collect();
      for (const w of waiters) {
        // Schedule the callback (re-enqueue the blocked caller).
        await ctx.scheduler.runAfter(
          0,
          w.callbackHandle as any,
          w.callbackArgs ?? {},
        );
        await ctx.db.delete(w._id);
      }
    }
    return null;
  },
});

// ── Blocking (retry) ───────────────────────────────────────────────────

/**
 * Register waiters and re-validate the read set.
 * Returns true if safe to block (all values unchanged).
 * Returns false if a value changed (caller should retry immediately).
 */
export const block = mutation({
  args: {
    reads: v.array(v.object({ key: v.string(), expectedValue: v.any() })),
    callbackHandle: v.string(),
    callbackArgs: v.optional(v.any()),
  },
  returns: v.boolean(),
  handler: async (ctx, { reads, callbackHandle, callbackArgs }) => {
    // Step 1: Insert a waiter for each TVar in the read set.
    const waiterIds: Id<"waiters">[] = [];
    for (const { key } of reads) {
      const id = await ctx.db.insert("waiters", {
        tvarKey: key,
        callbackHandle,
        callbackArgs,
      });
      waiterIds.push(id);
    }

    // Step 2: Re-validate. Did any TVar change since we read it?
    // This is the paper's "validate before blocking" (Section 6.3).
    // Prevents lost-wakeup race: if a write committed between our read
    // and our waiter insertion, we catch it here.
    for (const { key, expectedValue } of reads) {
      const doc = await ctx.db
        .query("tvars")
        .withIndex("by_key", (q) => q.eq("key", key))
        .unique();
      const currentValue = doc?.value ?? null;
      if (!deepEqual(currentValue, expectedValue)) {
        // Value changed — don't block, clean up waiters.
        for (const id of waiterIds) {
          await ctx.db.delete(id);
        }
        return false; // Caller should retry immediately.
      }
    }

    // All values still match — safe to block.
    return true;
  },
});

// ── Init ───────────────────────────────────────────────────────────────

/**
 * Initialize a TVar with a value if it doesn't already exist.
 */
export const init = mutation({
  args: { key: v.string(), value: v.any() },
  returns: v.null(),
  handler: async (ctx, { key, value }) => {
    const existing = await ctx.db
      .query("tvars")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();
    if (!existing) {
      await ctx.db.insert("tvars", { key, value });
    }
    return null;
  },
});

// ── Helpers ────────────────────────────────────────────────────────────

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((val, i) => deepEqual(val, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  if (aKeys.length !== Object.keys(bObj).length) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}
