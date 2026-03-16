# Convex STM

> **This is a research prototype / toy implementation** for understanding
> how Software Transactional Memory maps onto the Convex platform. It
> implements the core primitives from the 2005 paper and demonstrates
> them with interactive examples, but it is not production infrastructure.
> The real value is in the [proposed platform primitives](#proposed-platform-primitives)
> that could make these patterns native to Convex.

Operations that wait for the right conditions and complete automatically.
When conditions change, blocked operations re-run and pick up where they
left off. No polling. No subscriptions. No event wiring.

Based on [Harris et al., "Composable Memory Transactions" (PPoPP 2005)](https://research.microsoft.com/en-us/um/people/simonpj/papers/stm/),
with ideas from Haskell GHC, Clojure STM, and Scala ScalaSTM.

## The primitives

### `tx.read(key)` / `tx.write(key, value)`

Read and write shared state inside a transaction. Reads fetch on demand.
Writes are buffered and applied atomically when the transaction commits.

### `tx.retry()`

"I can't proceed right now." The system records what was read, waits
until one of those values changes, then re-runs the transaction.

### `tx.select(...branches)`

Try each branch in order. First one that doesn't retry wins. If all
retry, wait for any of their conditions to change. Branches can have
a timeout — give up after N ms and try the next one.

```typescript
await tx.select(
  { fn: async () => claimFrom(tx, "printful"), timeout: 3000 },
  { fn: async () => claimFrom(tx, "printify"), timeout: 5000 },
  async () => claimFrom(tx, "gooten"),
);
```

### `tx.afterCommit(fn)`

Schedule IO to run after the transaction commits. If the transaction
retries or throws, the callback is discarded. Use this to bridge
between pure STM logic and side effects (fetch, actions, etc).

```typescript
await stm.atomic(ctx, async (tx) => {
  tx.write("order:status", "submitted");
  tx.afterCommit(async (ctx) => {
    await ctx.scheduler.runAfter(0, internal.actions.callProvider, {});
  });
});
```

### `tx.take(key)` / `tx.put(key, value)` (TMVar)

A TVar that can be empty or full. `take` blocks if empty, leaves it
empty. `put` blocks if full. Classic producer/consumer channel.

```typescript
await stm.initTMVar(ctx, "slot");             // empty
const val = await tx.take("slot");            // blocks until someone puts
await tx.put("slot", result);                 // blocks until someone takes
```

### `stm.atomic(ctx, handler, onRetry?)`

Run the handler atomically. Returns `{ committed: true, value }` on
success, or `{ committed: false, timedOut }` if the handler retried.

If `onRetry` is provided, registers waiters so the transaction is
re-run when watched TVars change. For timeout correctness, pass a
stable `txId` that's the same across reruns:

```typescript
await stm.atomic(ctx, handler, {
  callbackHandle: retryHandle,
  callbackArgs: { orderId },
  txId: `order:${orderId}:wait`,  // stable across retries
});
```

## Example: multi-item fulfillment

Three print providers, each making different products. An order for
shirt + mug + poster must be split across them.

```typescript
// Phase 1: submit to all providers at once
await stm.atomic(ctx, async (tx) => {
  for (const item of ["shirt", "mug", "poster"]) {
    for (const p of providersFor(item)) {
      if (!await tx.read(`provider:${p}:online`)) continue;
      tx.write(`${orderId}:${item}:${p}`, "submitted");

      // IO happens only if this transaction commits
      tx.afterCommit(async (ctx) => {
        await ctx.scheduler.runAfter(0, submitToProvider, { item, provider: p });
      });
    }
  }
});
// → Actions call fetch() to each provider
// → Providers webhook back accepted/rejected
// → Webhook writes the TVar → transaction re-runs

// Phase 2: wait for results with timeout + automatic re-run
const result = await stm.atomic(ctx, async (tx) => {
  const winners = {};
  for (const item of ["shirt", "mug", "poster"]) {
    winners[item] = await tx.select(
      ...providersFor(item).map(p => ({
        fn: async () => {
          const s = await tx.read(`${orderId}:${item}:${p}`);
          if (s === "accepted") return p;
          tx.retry();
        },
        timeout: 3000,
      })),
    );
  }
  return winners;
}, {
  // Re-run automatically when a TVar changes (provider responds)
  callbackHandle: retryHandle,
  callbackArgs: { orderId },
  txId: `order:${orderId}:wait`,  // stable across retries
});
// committed → all items sourced → ship it
// not committed + timedOut → all branches timed out → order expired
```

## How it works

1. Your function reads shared state and decides what to do
2. If it calls `tx.retry()`, the system records what was read
3. The operation waits (no CPU, no polling)
4. When any of those values change, the operation re-runs
5. Writes are buffered and applied atomically on commit
6. `afterCommit` callbacks fire only after a successful commit

Convex's mutation/action split enforces **no IO inside transactions**
at the platform level — the same guarantee the original paper gets
from Haskell's type system.

## Installation

```sh
npm install @convex-dev/stm
```

```typescript
// convex/convex.config.ts
import { defineApp } from "convex/server";
import stm from "@convex-dev/stm/convex.config.js";

const app = defineApp();
app.use(stm);
export default app;
```

```typescript
import { STM } from "@convex-dev/stm";
const stm = new STM(components.stm);
```

## Demo

**[Live demo](https://good-civet-579.convex.site)**

Two interactive examples:
- **Fulfillment** — multi-item orders across three print providers with fetch + webhooks
- **Priority Queue** — TVars as queues with select-based priority consumption

```sh
npm i
npm run dev
```

## Proposed platform primitives

This component proves that STM works on Convex, but the best version
of these ideas would be built into the platform. Three proposed
primitives that would make 80% of STM use cases native:

### `ctx.db.waitUntil(query, predicate)`

A mutation that blocks until a database condition holds. The runtime
tracks which documents were read and re-runs the mutation when any
change. No polling, no waiter tables, no TVars.

```typescript
const item = await ctx.db.waitUntil(
  ctx.db.query("inventory").filter(q => q.eq(q.field("sku"), "widget")),
  (doc) => doc.stock > 0,
);
await ctx.db.patch(item._id, { stock: item.stock - 1 });
```

### `ctx.scheduler.onDocumentChange(docId, fn, args)`

Schedule a function to run when a specific document changes. One-shot
trigger built into the commit path. Replaces the waiter table + wake
mechanism.

```typescript
await ctx.scheduler.onDocumentChange(orderId, internal.checkOrder, { orderId });
```

### `reactiveMutation`

A mutation that re-runs automatically when its reads change.
`ctx.suspend()` discards writes and registers a wake trigger.

```typescript
export const fulfillOrder = reactiveMutation({
  handler: async (ctx, { orderId }) => {
    const allReady = await checkAllItemsReady(ctx, orderId);
    if (!allReady) return ctx.suspend();
    await commitOrder(ctx, orderId);
  },
});
```

See [model/proposed-platform-primitives.md](./model/proposed-platform-primitives.md)
for full specs with semantics, edge cases, and implementation sketches.

## Design

- [model/stm.md](./model/stm.md) — invariants, correctness proofs, paper coverage
- [model/extensions.md](./model/extensions.md) — future directions
- [model/proposed-platform-primitives.md](./model/proposed-platform-primitives.md) — platform-level specs
