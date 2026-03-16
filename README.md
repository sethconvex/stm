# Convex STM

Operations that wait for the right conditions and complete automatically.
When conditions change, blocked operations re-run and pick up where they
left off.

## What it does

You write a function that reads some shared state. If the state isn't
ready (out of stock, provider offline, slot full), call `tx.retry()`.
The operation waits — and when the state changes, it re-runs automatically.

No polling. No subscriptions. No event wiring.

## Example: multi-item fulfillment

A t-shirt store uses three print providers, each making different products:

| Provider | Makes |
|----------|-------|
| Printful | shirt, mug |
| Printify | shirt, poster |
| Gooten | mug, poster |

An order for shirt + mug + poster must be split across providers.

### Step 1: One function to try one provider

```typescript
async function tryProvider(tx: TX, orderId: string, item: string, provider: string) {
  const available = await tx.read(`provider:${provider}:available`);
  if (!available) tx.retry();  // offline — skip, watch for it to come back

  const result = await tx.read(`order:${orderId}:${item}:${provider}`);
  if (result === null) {
    tx.write(`order:${orderId}:${item}:${provider}`, "submitted");
    return provider;  // submit to this provider
  }
  if (result === "submitted") tx.retry();    // waiting for API response
  if (result === "accepted")  return provider; // done!
  tx.retry();  // rejected — try next
}
```

### Step 2: Select across providers for one item

```typescript
const provider = await tx.select(
  async () => await tryProvider(tx, orderId, "shirt", "printful"),
  async () => await tryProvider(tx, orderId, "shirt", "printify"),
);
```

Tries each provider in order. First one that doesn't block wins.

### Step 3: Compose into a cart — all items atomic

```typescript
await stm.atomic(ctx, async (tx) => {
  for (const item of ["shirt", "mug", "poster"]) {
    await tx.select(
      ...providersFor(item).map(p => async () =>
        await tryProvider(tx, orderId, item, p)
      ),
    );
  }
});
```

If any item can't be sourced, the **whole cart waits**. When a provider
comes back online, the cart re-evaluates and completes atomically.

### Step 4: Provider responds via webhook

The provider's API response (or webhook) writes the result, which
triggers the cart transaction to re-run:

```typescript
await stm.atomic(ctx, async (tx) => {
  tx.write(`order:${orderId}:${item}:${provider}`, "accepted");
});
// ^ This wakes the blocked cart. It re-runs, sees the acceptance,
//   and continues with the next item.
```

## How it works

1. Your function reads shared state and decides what to do
2. If it calls `tx.retry()`, the system records what was read
3. The operation waits (no CPU, no polling)
4. When any of those values change, the operation re-runs from scratch
5. Writes are buffered and applied atomically when the function returns

Based on [Harris et al., "Composable Memory Transactions" (PPoPP 2005)](https://research.microsoft.com/en-us/um/people/simonpj/papers/stm/).

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

## API

### `stm.atomic(ctx, handler, onRetry?)`

Run a function atomically. Reads happen on demand. Writes are buffered
and committed together.

### `await tx.read(key)` / `tx.write(key, value)`

Read and write shared state inside a transaction.

### `tx.retry()`

"I can't proceed right now." Waits for a read value to change, then
re-runs.

### `tx.select(option1, option2, ...)`

Try each option in order. First one that doesn't retry wins. If all
retry, wait for any of their conditions to change.

### `tx.orElse(fn1, fn2)`

Two-option version of `select`.

### `stm.init(ctx, key, value)`

Set an initial value. No-op if it already exists.

## Demo

See the [example app](./example) for a complete multi-item fulfillment
system with simulated provider APIs, webhooks, and provider failover.

```sh
npm i
npm run dev
```

## Design docs

- [model/stm.md](./model/stm.md) — invariants and correctness proofs
- [model/extensions.md](./model/extensions.md) — future directions
