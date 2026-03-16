import { mutation, query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { STM } from "@convex-dev/stm";
import { v } from "convex/values";
import type { TX } from "@convex-dev/stm";

const stm = new STM(components.stm);

const QUEUES = ["critical", "normal", "bulk"] as const;

// ═══════════════════════════════════════════════════════════════════════
//  Queue = a TVar holding an array. push appends, shift removes first.
// ═══════════════════════════════════════════════════════════════════════

async function queuePush(tx: TX, queue: string, job: string) {
  const items = ((await tx.read(`queue:${queue}`)) as string[] | null) ?? [];
  tx.write(`queue:${queue}`, [...items, job]);
}

async function queueShift(tx: TX, queue: string): Promise<string> {
  const items = ((await tx.read(`queue:${queue}`)) as string[] | null) ?? [];
  if (items.length === 0) tx.retry(); // empty — block until something is pushed
  tx.write(`queue:${queue}`, items.slice(1));
  return items[0];
}

// ═══════════════════════════════════════════════════════════════════════
//  Enqueue a job into a specific priority queue
// ═══════════════════════════════════════════════════════════════════════

export const enqueue = mutation({
  args: { queue: v.string(), job: v.string() },
  handler: async (ctx, { queue, job }) => {
    await stm.atomic(ctx, async (tx) => {
      await queuePush(tx, queue, job);
    });
  },
});

// Batch enqueue — one mutation for multiple jobs
export const enqueueBatch = mutation({
  args: { jobs: v.array(v.object({ queue: v.string(), job: v.string() })) },
  handler: async (ctx, { jobs }) => {
    await stm.atomic(ctx, async (tx) => {
      for (const { queue, job } of jobs) {
        await queuePush(tx, queue, job);
      }
    });
  },
});

// Batch dequeue — one mutation takes N jobs
export const dequeueBatch = mutation({
  args: { count: v.number() },
  handler: async (ctx, { count }) => {
    const taken: { queue: string; job: string }[] = [];
    for (let i = 0; i < count; i++) {
      const result = await stm.atomic(ctx, async (tx) => {
        return await tx.select(
          async () => ({ queue: "critical", job: await queueShift(tx, "critical") }),
          async () => ({ queue: "normal", job: await queueShift(tx, "normal") }),
          async () => ({ queue: "bulk", job: await queueShift(tx, "bulk") }),
        );
      });
      if (!result.committed) break;
      taken.push(result.value);
      await ctx.db.insert("processedJobs", {
        queue: result.value.queue,
        job: result.value.job,
        at: Date.now(),
      });
    }
    return taken;
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Worker: take from highest-priority non-empty queue
// ═══════════════════════════════════════════════════════════════════════
//  select() tries critical first. If empty, normal. If empty, bulk.
//  If ALL empty, blocks until any queue gets a job.

export const dequeue = mutation({
  args: {},
  handler: async (ctx) => {
    const result = await stm.atomic(ctx, async (tx) => {
      return await tx.select(
        async () => ({ queue: "critical", job: await queueShift(tx, "critical") }),
        async () => ({ queue: "normal", job: await queueShift(tx, "normal") }),
        async () => ({ queue: "bulk", job: await queueShift(tx, "bulk") }),
      );
    });

    if (result.committed) {
      // Log the processed job
      await ctx.db.insert("processedJobs", {
        queue: result.value.queue,
        job: result.value.job,
        at: Date.now(),
      });
      return result.value;
    }
    return null; // all queues empty
  },
});

// ═══════════════════════════════════════════════════════════════════════
//  Read queue state
// ═══════════════════════════════════════════════════════════════════════

export const readQueues = query({
  args: {},
  handler: async (ctx) => {
    const result: Record<string, string[]> = {};
    for (const q of QUEUES) {
      result[q] = ((await ctx.runQuery(components.stm.lib.readTVar, {
        key: `queue:${q}`,
      })) as string[] | null) ?? [];
    }
    return result;
  },
});

export const readProcessed = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("processedJobs").order("desc").take(15);
  },
});

export const setupQueues = mutation({
  args: {},
  handler: async (ctx) => {
    // Init empty queues
    for (const q of QUEUES) {
      await stm.init(ctx, `queue:${q}`, []);
    }
    // Clear processed log
    const jobs = await ctx.db.query("processedJobs").collect();
    for (const j of jobs) await ctx.db.delete(j._id);
  },
});
