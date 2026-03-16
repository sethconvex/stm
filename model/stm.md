# Composable Memory Transactions for Convex

A standalone Convex component implementing STM (Software Transactional Memory)
based on Harris et al., "Composable Memory Transactions" (PPoPP 2005).

## Problem

Atomic read-modify-write on multiple documents is easy (one mutation).
But **blocking until a condition holds** and **composing alternatives** is not:

```typescript
// Easy: atomic transfer (single mutation)
const transfer = mutation(async (ctx) => {
  const a = await ctx.db.get(accountA);
  const b = await ctx.db.get(accountB);
  await ctx.db.patch(accountA, { balance: a.balance - 100 });
  await ctx.db.patch(accountB, { balance: b.balance + 100 });
});

// Hard: block until account A has enough funds
// Hard: try account A, else try account B
// Hard: compose the above without knowing internals
```

STM solves this with three primitives: **TVars**, **retry**, and **orElse**.

## Design

### Architecture

```
┌─────────────────────────────────────────────┐
│  User code                                  │
│                                             │
│  const result = await stm.atomic(ctx, tx => {│
│    const bal = tx.read("balance");          │
│    if (bal < 100) tx.retry();               │
│    tx.write("balance", bal - 100);          │
│  });                                        │
└──────────────┬──────────────────────────────┘
               │
┌──────────────▼──────────────────────────────┐
│  @convex-dev/stm  (Convex Component)        │
│                                             │
│  Tables:  tvars, waiters                    │
│  Mutations: commit, block, wake             │
│  Trigger: on tvars write → wake waiters     │
│  Client: STMManager.atomic(ctx, fn)         │
└─────────────────────────────────────────────┘
```

### Tables

```
tvars:
  key: string        (unique name, indexed)
  value: any         (serializable value)

waiters:
  tvarKey: string    (which TVar, indexed)
  callback: string   (serialized callback reference — scheduler handle + args)
```

That's it. Two tables.

### Client API

```typescript
import { STM } from "@convex-dev/stm";

const stm = new STM(components.stm);

// Read a TVar
const val = tx.read("balance");

// Write a TVar (buffered until commit)
tx.write("balance", val - 100);

// Block until something I read changes
tx.retry();

// Try A; if A retries, try B
tx.orElse(() => tryA(tx), () => tryB(tx));

// Run atomically (from a mutation)
const result = await stm.atomic(ctx, (tx) => {
  const bal = tx.read("balance");
  if (bal < 100) tx.retry();
  tx.write("balance", bal - 100);
  return bal - 100;
});
```

### Composability Examples

```typescript
// Composable building blocks (these are just functions, not mutations)
function withdraw(tx: TX, account: string, amount: number) {
  const bal = tx.read(account);
  if (bal < amount) tx.retry();  // blocks until balance changes
  tx.write(account, bal - amount);
}

function deposit(tx: TX, account: string, amount: number) {
  const bal = tx.read(account);
  tx.write(account, bal + amount);
}

// Sequential composition — both atomic
function transfer(tx: TX, from: string, to: string, amount: number) {
  withdraw(tx, from, amount);
  deposit(tx, to, amount);
}

// Choice — try A, else B
function withdrawFromEither(tx: TX, a: string, b: string, amount: number) {
  tx.orElse(
    () => withdraw(tx, a, amount),
    () => withdraw(tx, b, amount),
  );
}
```

## Execution Model

A call to `stm.atomic(ctx, fn)` runs inside the caller's Convex mutation.
It is NOT a separate mutation — it extends the caller's transaction.

```
stm.atomic(ctx, fn):

  SETUP:
    readSet  = {}    // tvarKey → value seen
    writeSet = {}    // tvarKey → new value

  RUN fn(tx):
    tx.read(key):
      if key in writeSet → return writeSet[key]  (read-your-writes)
      val = ctx.db.query("tvars").withIndex("by_key", key).unique().value
      readSet[key] = val
      return val

    tx.write(key, val):
      writeSet[key] = val                        (buffered, not applied yet)

    tx.retry():
      throw RetrySignal(readSet)

    tx.orElse(fn1, fn2):
      saved = { readSet: {...readSet}, writeSet: {...writeSet} }
      try { return fn1() }
      catch (RetrySignal) {
        mergedReads = {...readSet}                // keep fn1's reads
        readSet = saved.readSet                   // restore pre-fn1
        writeSet = saved.writeSet                 // discard fn1 writes
        Object.assign(readSet, mergedReads)       // merge fn1 reads
        return fn2()                              // may also retry
      }

  OUTCOME:

    fn returns value V  →  COMMIT:
      for each (key, val) in writeSet:
        upsert tvars doc {key, value: val}
        // Trigger fires automatically → wakes waiters (see below)
      return V

    fn throws RetrySignal  →  BLOCK:
      writeSet discarded (never applied)
      for each key in readSet:
        insert waiter {tvarKey: key, callback: <caller's wake info>}
      // Re-validate: did any TVar change since we read it?
      for each (key, expectedVal) in readSet:
        currentVal = ctx.db.query("tvars").withIndex("by_key", key).value
        if currentVal !== expectedVal:
          // Something changed — don't block, tell caller to retry now
          delete all waiters we just inserted
          throw RetryNow
      // Values unchanged — safe to block
      return BLOCKED

    fn throws other Error  →  ABORT:
      writeSet discarded (never applied)
      throw Error (propagates to caller)
```

## Wake Protocol (Trigger)

The entire wake mechanism is a single trigger on the `tvars` table:

```typescript
triggers.register("tvars", async (ctx, change) => {
  if (change.operation === "insert" || change.operation === "update") {
    const key = change.newDoc.key;
    const waiters = await ctx.db.query("waiters")
      .withIndex("by_tvar", q => q.eq("tvarKey", key))
      .collect();
    for (const w of waiters) {
      await ctx.db.delete(w._id);
      await ctx.scheduler.runAfter(0, internal.stm.wake, w.callback);
    }
  }
});
```

- Runs **inside the same mutation** as the TVar write (atomic).
- Any write to any TVar — from STM commit, direct mutation, anywhere — wakes waiters.
- Waiter deletion + wake scheduling is atomic with the write. No lost wakeups.

## Integration with Workflows

When used from a workflow, `stm.atomic()` is called inside a step mutation.
The "callback" stored in the waiter is "re-enqueue this workflow."

```typescript
// In workflow step handler:
const result = await step.stm(async (tx) => {
  withdraw(tx, "checking", 100);
  deposit(tx, "savings", 100);
});

// If the STM retries:
//   - Waiter rows point back to this workflow
//   - When TVar changes, trigger wakes the workflow
//   - Workflow replays, re-runs the STM step
//   - This time the condition may pass → commit
```

When used standalone (no workflow), the caller decides what "wake" means.
Could be a scheduled mutation, a channel signal, etc.

## Invariants

**INV1 (Atomicity):**
All TVar reads see a consistent snapshot; all writes apply atomically.
*Proof:* `stm.atomic` runs inside a single Convex mutation. Convex OCC
guarantees snapshot isolation. Writes are buffered and applied at the end.

**INV2 (Retry has no write effects):**
A retrying transaction never modifies TVars.
*Proof:* writeSet is a JavaScript object. On RetrySignal, the code path
never calls `ctx.db.patch/insert` on tvars. Only waiter rows are inserted.

**INV3 (No lost wakeups):**
If a TVar is written after a waiter is registered, the waiter is woken.
*Proof:* The trigger fires on every tvars table write, inside the same mutation.
Two cases for a concurrent retry + write:
  (a) Retry mutation commits first → waiter exists → write's trigger sees it → wake ✓
  (b) Write mutation commits first → retry's re-validation sees new value →
      RetryNow (immediate re-run, no blocking) ✓
  (c) OCC conflict → one retries → reduces to (a) or (b) ✓

**INV4 (orElse isolation):**
fn1's writes are invisible to fn2 if fn1 retries.
*Proof:* orElse saves writeSet before fn1, restores on RetrySignal. fn1's
buffered writes are discarded. fn1's reads are kept (merged) so the combined
watch set covers both branches. Matches paper Section 6.4.

**INV5 (No deadlock):**
STM transactions cannot deadlock.
*Proof:* No locks exist. Convex OCC resolves write conflicts by retrying.
A blocked transaction waits on TVar values, not on other transactions.

**INV6 (Re-validation prevents stale blocking):**
A transaction never blocks on an already-stale read set.
*Proof:* After inserting waiters, the BLOCK path re-reads every TVar in readSet.
If any value differs from what was originally read, waiters are deleted and the
caller is told to retry immediately. This re-read + waiter insertion happens in
the same mutation, so no write can slip between them undetected.

## Race Condition Analysis

### R1: Two commits write the same TVar
Convex OCC detects conflict → one retries automatically → serialized ✓

### R2: Commit writes TVar while another transaction is blocking

**R2a: Block mutation commits first**
Waiter row exists → commit's trigger sees it → wakes workflow ✓

**R2b: Commit mutation commits first**
TVar has new value → block's re-validation detects mismatch → RetryNow ✓

**R2c: Concurrent (OCC conflict)**
One mutation retries → reduces to R2a or R2b ✓

### R3: Two transactions both retry on same TVar
Both insert waiter rows (different rows, no conflict) → both woken on next write ✓

### R4: Wake fires but transaction still can't proceed
Workflow re-runs STM step → reads new values → may retry again → new waiter rows ✓
Old waiter rows were deleted by the trigger. No stale waiters accumulate.

### R5: Waiter woken but workflow already completed/canceled
Wake calls scheduler.runAfter → workflow step checks if still relevant → no-op ✓
(Same pattern as existing event wake in workflows.)

## Component Structure

```
@convex-dev/stm/
├── src/
│   ├── component/
│   │   ├── convex.config.ts    # defineComponent("@convex-dev/stm")
│   │   ├── schema.ts           # tvars + waiters tables
│   │   ├── stm.ts              # commit, block, wake mutations
│   │   └── _generated/         # convex codegen
│   ├── client/
│   │   └── index.ts            # STMManager class, TX context
│   └── types.ts                # Shared types (RetrySignal, etc.)
├── package.json
└── tsconfig.json
```

## Coverage of the Paper

| Paper Concept | Status | How |
|---|---|---|
| TVar (transactional variable) | ✓ | String keys in component `tvars` table |
| readTVar / writeTVar | ✓ | `tx.read()` / `tx.write()` — async, on-demand |
| atomic | ✓ | `stm.atomic(ctx, handler)` |
| retry | ✓ | `tx.retry()` + waiter wake mechanism |
| orElse | ✓ | `tx.orElse(fn1, fn2)` with write rollback |
| Sequential composition | ✓ | `async/await` inside handler |
| Exception abort semantics | ✓ | Throws discard buffered writes |
| **No IO in transactions** | ✓ | **Convex enforces this.** Mutations can't call `fetch()`, `Math.random()`, or any non-deterministic IO. The paper uses Haskell's monadic type system to prevent IO inside STM. Convex's mutation/action split gives us the same guarantee at the platform level — no language-level type tricks needed. |
| select (our addition) | ✓ | `tx.select()` = variadic orElse, with optional per-branch timeout |
| Timeout (our addition) | ✓ | `{ fn, timeout }` branches in select — composable with retry and orElse |

### Not implemented

- **newTVar inside transactions.** The paper lets you allocate TVars inside a
  transaction; allocations survive even on abort. We require `stm.init()` outside.
- **tx.catch().** The paper supports catching exceptions within a transaction and
  continuing. We only support exceptions propagating out (abort semantics).
- **Nested transaction logs.** The paper's `orElse` uses genuine nested logs with
  parent-chain lookups. We simulate with save/restore on a flat writeSet. Correct
  behavior, different architecture.

## What This Doesn't Do

- **No cross-mutation atomicity.** Each `stm.atomic()` call lives inside one Convex
  mutation. You can't span two mutations. (Same as the paper: each `atomic` is one
  transaction.)
- **No distributed transactions.** TVars live in one Convex deployment.
- **No starvation prevention.** A long transaction may repeatedly conflict with short
  ones. (Paper Section 6.5.)
- **No infinite retry detection.** If the condition never becomes true, the waiter
  waits forever. Application bug, not a system bug.
