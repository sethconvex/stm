# Convex STM

Operations that wait for the right conditions and complete automatically.

## What it does

You write a function that reads some state and maybe writes some state. If the
state isn't ready yet (out of stock, slot not available, balance too low), call
`tx.retry()`. The operation **waits** — and when the state changes, it
**re-runs automatically** and completes.

No polling. No subscriptions. No event plumbing.

## Example: ordering from a warehouse

```ts
async function buyFrom(tx: TX, warehouse: string, amount: number) {
  const stock = await tx.read(warehouse);
  if (stock < amount) tx.retry();   // not enough — wait for restock
  tx.write(warehouse, stock - amount);
}
```

That's it. `buyFrom` doesn't know how restocking works, who else is buying,
or what happens when stock runs out. It just says "I need this condition to
hold" and the system handles the rest.

### Wait for stock

```ts
// If us-west is empty, this order waits.
// When someone restocks us-west, the order auto-completes.
await stm.atomic(ctx, async (tx) => {
  await buyFrom(tx, "us-west", 1);
});
```

### Try multiple options

```ts
// Try US first. If empty, try EU. If empty, try Asia.
// If ALL are empty, wait for ANY of them to restock.
await stm.atomic(ctx, async (tx) => {
  return await tx.select(
    async () => { await buyFrom(tx, "us-west", 1);    return "us-west"; },
    async () => { await buyFrom(tx, "eu-central", 1); return "eu-central"; },
    async () => { await buyFrom(tx, "asia-east", 1);  return "asia-east"; },
  );
});
```

Each option is tried in order. If it can't proceed, its changes are rolled
back and the next option is tried. If none can proceed, the operation waits
for any of them to become possible.

### Restock wakes waiting orders

```ts
// Adding stock automatically wakes any orders waiting for it.
await stm.atomic(ctx, async (tx) => {
  const stock = await tx.read("us-west");
  tx.write("us-west", stock + 10);
});
// ^ Any orders blocked on "us-west" will now re-run and complete.
```

## How it works

1. Your function reads some shared variables and decides what to do
2. If it calls `tx.retry()`, the system records what was read
3. The operation waits (no CPU, no polling)
4. When any of those variables change, the operation re-runs from scratch
5. This time conditions might be met — if so, writes are committed atomically

This is based on [Software Transactional Memory](https://research.microsoft.com/en-us/um/people/simonpj/papers/stm/)
(Harris et al., 2005), adapted for Convex's serverless model.

## Installation

```sh
npm install @convex-dev/stm
```

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import stm from "@convex-dev/stm/convex.config.js";

const app = defineApp();
app.use(stm);

export default app;
```

```ts
// In your code
import { STM } from "@convex-dev/stm";
const stm = new STM(components.stm);
```

## API

### `stm.atomic(ctx, handler, onRetry?)`

Run a function atomically. Reads happen on demand. Writes are buffered and
committed together when the function returns.

```ts
await stm.atomic(ctx, async (tx) => {
  const count = await tx.read("visitors");
  tx.write("visitors", count + 1);
  return count + 1;
});
```

### `tx.read(key)` / `tx.write(key, value)`

Read and write shared variables inside a transaction. Reads fetch the current
value from the database. Writes are held in memory until the transaction commits.

### `tx.retry()`

"I can't proceed right now." Discards all writes, records what was read, and
waits. When any of those values change, the whole function re-runs.

### `tx.select(option1, option2, ...)`

Try each option in order. The first one that doesn't retry wins. If all retry,
wait for any of their conditions to change.

```ts
await tx.select(
  async () => { /* try this first */ },
  async () => { /* then this */ },
  async () => { /* last resort */ },
);
```

### `tx.orElse(fn1, fn2)`

The two-option version of `select`. Try `fn1`. If it retries, roll back its
writes and try `fn2`.

### `stm.init(ctx, key, value)`

Set a variable's initial value. Does nothing if it already exists.

## Development

```sh
npm i
npm run dev
```

The example app shows a warehouse ordering system where orders wait for stock
and auto-complete when it arrives. See `example/convex/example.ts`.

## Design

See [model/stm.md](./model/stm.md) for invariants, race condition analysis,
and correctness proofs.
