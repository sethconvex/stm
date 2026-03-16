# Platform Primitives for Reactive Mutations

Three additions to the Convex platform that would make STM-style
patterns native, performant, and invisible to developers.

## 1. `ctx.db.waitUntil(query, predicate)`

### What it does

A mutation that blocks until a database condition holds, then continues.
The runtime tracks which documents were read and re-runs the mutation
when any of them change. No polling. No waiter tables. No TVars.

### API

```typescript
export const buyWidget = mutation(async (ctx) => {
  // Blocks until stock > 0. Re-runs automatically when inventory changes.
  const item = await ctx.db.waitUntil(
    ctx.db.query("inventory").filter(q => q.eq(q.field("sku"), "widget")),
    (doc) => doc.stock > 0,
  );

  // We only reach here when the condition holds.
  await ctx.db.patch(item._id, { stock: item.stock - 1 });
  return { bought: "widget", remaining: item.stock - 1 };
});
```

### Semantics

1. Evaluate the query.
2. Apply the predicate to each result.
3. If predicate passes: return the matching document(s), continue execution.
4. If predicate fails: **suspend** the mutation. Record the read set
   (which documents + fields were accessed).
5. When any document in the read set is modified by another mutation,
   **resume** from step 1. The entire mutation re-runs from scratch
   (same as OCC retry, but triggered by data change instead of conflict).
6. The suspended mutation consumes no CPU while waiting.

### Edge cases

- **Timeout**: optional `{ timeout: 5000 }` parameter. If the condition
  doesn't hold within N ms, throw `TimeoutError` (or return null).
  ```typescript
  const item = await ctx.db.waitUntil(query, pred, { timeout: 5000 });
  if (!item) return { error: "timed out" };
  ```

- **Multiple waitUntil in one mutation**: each one blocks independently.
  The mutation suspends at the first unmet condition. When it resumes,
  it re-runs from the top — the first `waitUntil` may now pass, and
  the second one is evaluated. This is sequential, like STM's `retry`.

- **OCC interaction**: `waitUntil` is compatible with OCC. If another
  mutation modifies a document between the `waitUntil` check and the
  subsequent write, normal OCC retry kicks in. The `waitUntil`
  re-evaluates on the next attempt.

### Implementation sketch

- Convex already tracks reads for OCC (the read set). `waitUntil`
  reuses this: if the predicate fails, instead of committing (empty
  transaction), register the read set as a "wake trigger."
- Store wake triggers in a system table: `{ mutationId, readSet, createdAt }`.
- When any mutation commits writes that overlap with a wake trigger's
  read set, schedule the suspended mutation to re-run.
- The suspended mutation is a scheduled function (like `scheduler.runAfter(0, ...)`
  but triggered by data change instead of time).
- Cleanup: remove wake triggers when the mutation completes, times out,
  or the caller disconnects.

### What this replaces

- STM's `retry()` + waiter table + commit-based wake
- Polling loops (`setInterval` + query)
- Event-based plumbing (create event → await event → send event)
- The workflow component's `awaitEvent` for simple conditions

---

## 2. Reactive Mutations

### What it does

A mutation that can subscribe to query results within its execution.
When the subscribed data changes, the mutation is re-invoked automatically.
This is the mutation equivalent of reactive queries on the client.

### API

```typescript
export const fulfillOrder = reactiveMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    // This read is reactive — if the order changes, we re-run.
    const order = await ctx.db.get(orderId);
    if (!order || order.status === "fulfilled") return;

    // Check all providers for this order
    const responses = await ctx.db.query("providerResponses")
      .withIndex("by_order", q => q.eq("orderId", orderId))
      .collect();

    const accepted = responses.filter(r => r.result === "accepted");
    const allItemsCovered = order.items.every(item =>
      accepted.some(r => r.item === item)
    );

    if (!allItemsCovered) {
      // Not ready yet. Because this is a reactive mutation,
      // it will automatically re-run when providerResponses changes.
      return ctx.suspend();
    }

    // All items covered — fulfill the order.
    await ctx.db.patch(orderId, {
      status: "fulfilled",
      assignments: Object.fromEntries(
        order.items.map(item => [item, accepted.find(r => r.item === item)!.provider])
      ),
    });
  },
});
```

### Semantics

1. The mutation runs like a normal mutation.
2. If it calls `ctx.suspend()`, the mutation's writes are discarded
   (like a retry) and its read set is registered as a wake trigger.
3. When any document in the read set changes, the mutation re-runs
   from scratch with the same arguments.
4. If the mutation returns normally (no suspend), it commits as usual
   and the reactive subscription is removed.
5. The mutation can be canceled by the caller or by timeout.

### Difference from `waitUntil`

`waitUntil` is a single blocking read within a normal mutation.
Reactive mutations are entire mutations that re-run on data change.

- `waitUntil`: "block at this line until this specific query matches"
- Reactive mutation: "keep re-running this entire function until it
  completes without suspending"

`waitUntil` is simpler for most cases. Reactive mutations are needed
when the logic between reads is complex (multiple conditions, writes
to set up state before blocking, etc).

### Implementation sketch

- New function type `reactiveMutation` alongside `mutation`, `query`, `action`.
- Internally, a reactive mutation is a mutation + a wake trigger.
- On `ctx.suspend()`: discard write set, store read set as trigger,
  schedule re-run when trigger fires.
- On normal return: commit writes, remove trigger.
- The runtime maintains a registry of active reactive mutations per
  deployment, garbage-collected when they complete or time out.

---

## 3. `ctx.scheduler.onDocumentChange(docId, fn, args)`

### What it does

Schedule a function to run when a specific document changes. Like
`scheduler.runAfter` but triggered by data mutation instead of time.

### API

```typescript
// Schedule a callback when this document changes
await ctx.scheduler.onDocumentChange(
  orderId,
  internal.orders.checkFulfillment,
  { orderId },
);

// The callback receives the new document state
export const checkFulfillment = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get(orderId);
    // ... check if order is complete ...
  },
});
```

### Extended form: watch a query result

```typescript
// Watch any change to documents matching a query
await ctx.scheduler.onQueryChange(
  ctx.db.query("providerResponses")
    .withIndex("by_order", q => q.eq("orderId", orderId)),
  internal.orders.checkFulfillment,
  { orderId },
);
```

### Semantics

1. Register a trigger: when document `docId` (or any document matching
   the query) is modified by a mutation commit, schedule `fn(args)`.
2. The trigger fires **once** per registration. After firing, it's removed.
   (To keep watching, the callback can re-register.)
3. The trigger fires on any write to the document — insert, patch,
   replace, or delete.
4. The scheduled function runs as a normal mutation/action, not in the
   context of the writing mutation.

### Edge cases

- **Trigger on delete**: fires with the deleted document's ID. The
  callback's `ctx.db.get(docId)` returns null.
- **Multiple triggers on same document**: all fire independently.
- **Self-triggering**: if the callback modifies the watched document,
  it does NOT re-trigger itself (prevents infinite loops).
- **Cleanup**: triggers are removed when they fire, when explicitly
  canceled, or when a configurable TTL expires.
- **Cancellation**:
  ```typescript
  const triggerId = await ctx.scheduler.onDocumentChange(docId, fn, args);
  await ctx.scheduler.cancelTrigger(triggerId);
  ```

### Implementation sketch

- Store triggers in a system table: `{ docId, fnRef, args, createdAt, ttl }`.
- In the mutation commit path (after OCC validation succeeds, before
  returning to caller): check if any written document has triggers.
  If so, schedule the trigger's function via the existing scheduler.
- This is similar to the STM component's "commit writes → check
  waiters → schedule callbacks" pattern, but built into the platform.
- Index triggers by document ID for O(1) lookup during commit.
- For query-based triggers: maintain a mapping from query fingerprint
  to trigger. On commit, evaluate which queries are affected by the
  written documents (similar to how reactive queries invalidate).

### What this replaces

- STM's waiter table + commit wake mechanism
- Manual "poll for changes" patterns
- The workflow component's event system for simple "do X when Y changes"
- Webhook-to-internal-mutation bridges

---

## How they compose

These three primitives work together:

```typescript
// Simple case: waitUntil
const stock = await ctx.db.waitUntil(
  ctx.db.query("inventory").filter(q => q.eq(q.field("sku"), "widget")),
  (doc) => doc.stock > 0,
  { timeout: 5000 },
);

// Medium case: onDocumentChange for async workflows
await ctx.scheduler.onDocumentChange(orderId, internal.checkOrder, { orderId });

// Complex case: reactive mutation for multi-step coordination
export const fulfillCart = reactiveMutation({
  handler: async (ctx, { orderId }) => {
    // Reads are tracked. If any change, we re-run.
    const allReady = await checkAllItemsReady(ctx, orderId);
    if (!allReady) return ctx.suspend();
    await commitOrder(ctx, orderId);
  },
});
```

### Comparison to STM component

| STM Component | Platform Primitive | Advantage |
|---|---|---|
| `tx.retry()` | `ctx.db.waitUntil()` | No waiter tables, no TVars, uses existing read tracking |
| `tx.select()` / `tx.orElse()` | Multiple `waitUntil` + if/else | Simpler for most cases; STM still better for complex composition |
| Waiter table + commit wake | `scheduler.onDocumentChange()` | Built into commit path, O(1) per document, no extra tables |
| `stm.atomic()` + `onRetry` | `reactiveMutation` | No manual callback wiring, no txId management |
| TVar cleanup | Automatic | Triggers clean up on fire/timeout, no leaked state |

### What STM still adds

Even with these platform primitives, the STM component adds value for:

- **orElse/select composition** — "try A, if it blocks try B" with
  automatic write rollback. `waitUntil` can't do this because it
  doesn't know about alternative paths.
- **TMVar channels** — typed producer/consumer with backpressure.
  Not naturally expressible with document-level triggers.
- **Atomic multi-resource coordination** — reading N documents and
  committing only if ALL conditions hold. `waitUntil` handles one
  condition; STM handles N composed conditions.

The platform primitives handle 80% of use cases. STM handles the
remaining 20% where composition is the hard part.
