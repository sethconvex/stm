# Extending Composable Memory Transactions for Convex

Proposals for making STM more developer-friendly and more useful,
building on Harris et al. (2005) and the Convex platform's unique properties.

## 1. Reactive retry via Convex Subscriptions

**Problem:** The paper's `retry` blocks a thread and wakes it via TVar wait queues.
Our current implementation returns `{ committed: false }` and relies on the caller
to handle re-invocation. This is the biggest gap.

**Proposal:** Leverage Convex's built-in reactive queries to implement true `retry`.

```typescript
// User writes this:
const result = await stm.atomic(ctx, (tx) => {
  const stock = tx.read("tickets");
  if (stock < 1) tx.retry(); // "wake me when tickets changes"
  tx.write("tickets", stock - 1);
  return "booked";
});

// Under the hood:
// 1. Transaction retries → client registers waiters on ["tickets"]
// 2. Convex trigger on tvars table fires when "tickets" is written
// 3. Trigger wakes the caller (scheduler.runAfter or workflow re-enqueue)
// 4. Transaction re-runs, this time succeeds
```

For **standalone use** (outside workflows), retry could use Convex's reactive
query subscription on the client side:

```typescript
// React hook that auto-retries STM transactions
function useSTM<T>(handler: STMHandler<T>, keys: string[]): T | "pending" {
  const snapshot = useQuery(api.stm.readTVars, { keys });
  // When snapshot changes (reactive), re-run handler client-side
  // If handler succeeds, call commit mutation
  // If handler retries, wait for next snapshot update (automatic!)
}
```

This gives us `retry` for free using Convex's existing reactivity — no polling,
no explicit wake protocol needed for the client-side case. The waiter table is
only needed for server-side (workflow/action) callers.

**Why this matters:** Reactive retry means developers never write polling loops.
"Wait until X" becomes a one-liner regardless of what X depends on.

---

## 2. Typed TVars

**Problem:** TVars are currently `string → any`. No type safety on reads.

**Proposal:** Generic TVar references with validators.

```typescript
import { v } from "convex/values";

// Define a typed TVar
const ticketCount = stm.tvar("concert-tickets", v.number());
const cartItems = stm.tvar("cart:user123", v.array(v.string()));

// Type-safe reads — no casting
const count: number = tx.read(ticketCount);       // TS knows this is number
const items: string[] = tx.read(cartItems);        // TS knows this is string[]

// Type-safe writes — compile error on wrong type
tx.write(ticketCount, "hello"); // TS Error: string not assignable to number
```

Implementation: TVar reference is just `{ key: string, validator: Validator<T> }`.
`tx.read()` and `tx.write()` become generic over the TVar's type parameter.
Validation happens at write time (in the commit mutation) using convex-helpers
`validate()`.

---

## 3. Multi-way orElse (select)

**Problem:** Chaining `tx.orElse(a, () => tx.orElse(b, c))` is awkward for >2 alternatives.

**Proposal:** `tx.select()` — try N alternatives in order.

```typescript
const source = tx.select(
  () => { take(tx, "gold", 1);   return "gold"; },
  () => { take(tx, "silver", 1); return "silver"; },
  () => { take(tx, "bronze", 1); return "bronze"; },
);
// Equivalent to nested orElse, but cleaner.
// Implementation: foldr1 orElse over the array.
```

This is the paper's `merge = foldr1 orElse` (Section 4.3), surfaced as a
first-class API.

---

## 4. Workflow Integration: step.stm()

**Problem:** Using STM from a workflow requires manual plumbing — creating a step,
handling retry, wiring wake callbacks.

**Proposal:** First-class workflow step type.

```typescript
const myWorkflow = workflow.define({
  handler: async (step) => {
    // This is a single durable step that:
    // - Runs the STM transaction
    // - If it retries, the step stays inProgress
    // - When a watched TVar changes, the step auto-re-runs
    // - When it commits, the result is journaled
    const result = await step.stm((tx) => {
      const stock = tx.read("inventory:widget");
      if (stock < 1) tx.retry(); // workflow blocks here
      tx.write("inventory:widget", stock - 1);
      return "purchased";
    }, ["inventory:widget"]);
  },
});
```

The workflow's existing blocking infrastructure (step stays `inProgress`,
coordinator re-enqueues) handles retry naturally. The wake callback is
"re-enqueue this workflow," which is exactly what the event system already does.

---

## 5. TVar Lenses: Read/Write Subfields

**Problem:** Currently TVars hold entire values. If you want to update one field
of an object, you read the whole thing and write the whole thing back.

**Proposal:** Lenses for structured TVars.

```typescript
const user = stm.tvar("user:123", v.object({
  name: v.string(),
  balance: v.number(),
  inventory: v.array(v.string()),
}));

// Read just the balance (still tracks the whole TVar for retry)
const bal = tx.read(user, "balance");

// Write just the balance (merges into existing value)
tx.write(user, "balance", bal - 100);
```

This is sugar — under the hood it still reads/writes the whole TVar — but it
makes the API much more natural for structured data.

---

## 6. Invariants: always-true conditions

**Problem:** The paper briefly mentions invariants (Section 5 of a later 2006
paper by the same authors, "Transactional Memory with Data Invariants"). These
are conditions that must hold whenever any transaction commits.

**Proposal:** Register invariants that are checked on every commit.

```typescript
stm.invariant("total-conserved", (read) => {
  const gold = read("gold") as number;
  const silver = read("silver") as number;
  const bronze = read("bronze") as number;
  return gold + silver + bronze === 140;
});
```

If a commit would violate an invariant, the transaction is aborted with an error.
This catches bugs at the earliest possible point.

Implementation: store invariant functions in a registry. On commit, after applying
writes, evaluate all invariants that touch any written TVar. If any fails, abort.

---

## 7. Conflict-Free Counters (CRDTs meet STM)

**Problem:** High-contention TVars (e.g., counters, totals) cause OCC thrashing.
Many transactions read and write the same TVar, leading to frequent retries.

**Proposal:** Special "commutative" TVar operations that don't conflict.

```typescript
// Instead of:
const count = tx.read("pageviews") as number;
tx.write("pageviews", count + 1);
// (conflicts with every other increment)

// Use:
tx.increment("pageviews", 1);
// (commutative — multiple increments don't conflict)
```

The STM runtime can merge concurrent increments without OCC conflicts,
because addition is commutative and associative. This is similar to how
CRDTs handle concurrent updates, but scoped to the transaction model.

This only works for commutative operations (add, max, min, union, etc.),
not arbitrary writes. The TVar would need to store an operation log rather
than a single value, merged on read.

---

## 8. Transaction Timeouts

**Problem:** A transaction that retries may wait forever if the condition never
becomes true.

**Proposal:** Optional timeout on retry.

```typescript
const result = await stm.atomic(ctx, (tx) => {
  const stock = tx.read("tickets");
  if (stock < 1) tx.retry({ timeout: 30_000 }); // 30 seconds
  tx.write("tickets", stock - 1);
  return "booked";
}, ["tickets"]);

// result.status === "timeout" if it waited too long
```

Implementation: when registering waiters, also schedule a timeout mutation
via `ctx.scheduler.runAfter(timeoutMs, ...)`. If the timeout fires before
a wake, it deletes the waiters and returns a timeout result.

This is not in the original paper but is essential for production use.

---

## 9. Read-Only Transactions

**Problem:** Some transactions only read TVars (e.g., checking a complex condition
across multiple TVars). These don't need write buffering or commit.

**Proposal:** `stm.snapshot()` — a read-only transaction that sees a consistent
snapshot but never commits writes.

```typescript
const isEligible = await stm.snapshot(ctx, (tx) => {
  const balance = tx.read("balance") as number;
  const tier = tx.read("tier") as string;
  return balance > 1000 && tier === "gold";
}, ["balance", "tier"]);
```

Since Convex queries already see a consistent snapshot, this is mainly useful
for the retry semantics: "wait until this multi-TVar condition becomes true."

---

## 10. Debugging: Transaction Traces

**Problem:** When transactions retry or abort, it's hard to understand why.

**Proposal:** Optional transaction tracing.

```typescript
const result = await stm.atomic(ctx, handler, keys, {
  trace: true,
});

// result.trace = {
//   reads: [{ key: "gold", value: 0 }],
//   writes: [{ key: "gold", value: -1 }],  // would-be writes
//   outcome: "retry",
//   reason: "gold < 1 at line 3",
//   duration_ms: 2,
// }
```

Transaction traces are stored in a `stm_traces` table for debugging.
Enabled per-transaction, not globally (to avoid overhead).

---

## Priority Order

| # | Proposal | Impact | Effort | Priority |
|---|----------|--------|--------|----------|
| 1 | Reactive retry via subscriptions | High | Medium | P0 |
| 4 | Workflow integration (step.stm) | High | Medium | P0 |
| 2 | Typed TVars | High | Low | P1 |
| 3 | Multi-way select | Medium | Low | P1 |
| 8 | Transaction timeouts | Medium | Low | P1 |
| 6 | Invariants | Medium | Medium | P2 |
| 5 | TVar lenses | Medium | Low | P2 |
| 9 | Read-only transactions | Low | Low | P2 |
| 10 | Transaction traces | Medium | Medium | P3 |
| 7 | CRDT counters | High | High | P3 |

P0 items make STM actually useful in production.
P1 items make it developer-friendly.
P2-P3 items are nice-to-haves for advanced use cases.
