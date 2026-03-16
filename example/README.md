# Example: Multi-Item Fulfillment

A t-shirt store where orders are split across multiple print providers
automatically — and the whole cart either ships or waits together.

## The setup

Three print-on-demand providers, each making different products:

| Provider | Makes |
|----------|-------|
| Printful | shirt, mug |
| Printify | shirt, poster |
| Gooten | mug, poster |

No single provider makes shirt + mug + poster. An order for all three
**must** be split across providers.

## Step 1: The building block

One function that tries to get one item from one provider:

```typescript
async function tryProvider(tx, orderId, item, provider) {
  // Is this provider online?
  const available = await tx.read(`provider:${provider}:available`);
  if (!available) tx.retry();  // skip — but WATCH for it to come back

  // What happened last time we tried?
  const result = await tx.read(`order:${orderId}:${item}:${provider}`);
  if (result === null)       { tx.write(..., "submitted"); return provider; }
  if (result === "submitted")  tx.retry();   // waiting for API response
  if (result === "accepted")   return provider;  // done!
  tx.retry();  // rejected — try next provider
}
```

This function doesn't know about carts, other items, or other providers.
It just handles one item at one provider.

## Step 2: Select across providers

For each item, try every provider that makes it. First one that doesn't
block wins:

```typescript
const provider = await tx.select(
  async () => await tryProvider(tx, orderId, "shirt", "printful"),
  async () => await tryProvider(tx, orderId, "shirt", "printify"),
);
```

If Printful is offline, it retries (skips). Printify is tried next.
If both are down, the whole select blocks — and wakes when either
comes back online.

## Step 3: Compose items into a cart

Loop over every item. Each gets its own `select`. All items must
succeed in the same transaction:

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

If the shirt is sourced from Printful but the poster can't be sourced
from anyone, the **entire cart waits** — including the shirt. No partial
fulfillment. When a provider comes back online or a new one accepts,
the whole cart re-evaluates and completes atomically.

## Step 4: The provider API call

When the transaction commits with "submitted", an action calls the
provider's API (simulated here with a random delay + acceptance):

```typescript
export const submitToProvider = internalAction(async (ctx, { orderId, item, provider }) => {
  await fetch(`https://api.${provider}.com/orders`, { ... });
  // Or in the demo: simulate 1-3s delay, 70% acceptance
  const result = accepted ? "accepted" : "rejected";

  // Write result + re-run fulfillment
  await ctx.runMutation(internal.example.handleAndRetry, {
    orderId, item, provider, result,
  });
});
```

The mutation writes the result to the item's TVar, which triggers
the cart transaction to re-run. If the item was accepted, great.
If rejected, the transaction tries the next provider for that item.

## Step 5: Toggling providers

Click a provider card to take it offline. Any orders waiting for
that provider cascade to alternatives. Turn it back on and rejected
orders retry.

## Why this needs STM

A plain mutation can do any one of these steps. But composing them —
making a cart of items atomic across multiple providers, where each
item independently selects from its capable providers, and the whole
thing blocks and retries coherently — that's what STM gives you.

Without STM, you'd build a state machine with explicit transitions
for every combination of items × providers × states. With STM, you
write `tryProvider` once and compose it with `select` and `for`.

## Run it

```sh
npm i
npm run dev
```

Open http://localhost:5173 and try:
1. Order shirt + mug + poster (all three providers involved)
2. Turn Printful offline → orders route around it
3. Turn Printful back on → pending orders retry
