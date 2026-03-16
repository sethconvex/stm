# Convex STM

Composable memory transactions for Convex, based on
[Harris et al., "Composable Memory Transactions" (PPoPP 2005)](https://research.microsoft.com/en-us/um/people/simonpj/papers/stm/).

Atomic read-modify-write with **retry** (composable blocking) and
**orElse** (composable choice).

## The Problem

Convex mutations are already atomic. But you can't easily:

- **Block until a condition holds** without polling
- **Try alternative paths** when one blocks
- **Compose** the above without knowing implementation details

```ts
// Easy: atomic transfer
await ctx.db.patch(accountA, { balance: a - 100 });
await ctx.db.patch(accountB, { balance: b + 100 });

// Hard: block until accountA has enough funds
// Hard: try accountA, else try accountB
// Hard: compose the above
```

## The Solution

Three primitives: **TVars**, **retry**, and **orElse**.

```ts
import { STM } from "@convex-dev/stm";

const stm = new STM(components.stm);
```

### Composable Building Blocks

```ts
// These are plain functions. They compose freely.
function withdraw(tx: TX, account: string, amount: number) {
  const bal = tx.read(account) as number;
  if (bal < amount) tx.retry(); // block until balance changes
  tx.write(account, bal - amount);
}

function deposit(tx: TX, account: string, amount: number) {
  const bal = tx.read(account) as number;
  tx.write(account, bal + amount);
}
```

### Sequential Composition

Both operations happen in one atomic step:

```ts
export const transfer = mutation(async (ctx) => {
  await stm.atomic(ctx, (tx) => {
    withdraw(tx, "checking", 100);
    deposit(tx, "savings", 100);
  }, ["checking", "savings"]);
});
```

### Choice Composition (orElse)

Try account A first; if insufficient funds, try account B:

```ts
export const withdrawFromEither = mutation(async (ctx) => {
  await stm.atomic(ctx, (tx) => {
    tx.orElse(
      () => withdraw(tx, "checking", 100),
      () => withdraw(tx, "savings", 100),
    );
  }, ["checking", "savings"]);
});
```

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

## API

### `new STM(components.stm)`

Create an STM client from the installed component.

### `stm.init(ctx, key, value)`

Initialize a TVar. No-op if it already exists.

### `stm.atomic(ctx, handler, keys, onRetry?)`

Run `handler(tx)` as an atomic transaction over the named TVar keys.

- **Commit**: handler returns normally -> all writes applied atomically
- **Retry**: handler calls `tx.retry()` -> no writes, register waiters, block
- **Abort**: handler throws -> no writes, exception propagates

### `tx.read(key)` / `tx.write(key, value)`

Read/write TVars inside a transaction. Writes are buffered until commit.

### `tx.retry()`

Block until something we read changes. The system tracks exactly which
TVars were read and wakes us when any of them is written.

### `tx.orElse(fn1, fn2)`

Try `fn1`. If it retries, discard its writes and try `fn2`.
If both retry, block on the union of their read sets.

## Design

See [model/stm.md](./model/stm.md) for the full design doc with
invariants and race condition analysis.

## Development

```sh
npm i
npm run dev
```
