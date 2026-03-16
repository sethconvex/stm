import { internalAction } from "./_generated/server.js";
import { v } from "convex/values";

// ═══════════════════════════════════════════════════════════════════════
//  Submit an order to a provider via HTTP
// ═══════════════════════════════════════════════════════════════════════
//
//  This action calls the provider's API (fetch) and that's it.
//  The provider processes the request and calls our webhook back.
//  We don't wait for the result here — the webhook handles it.
//
//  In production: fetch("https://api.printful.com/orders", { ... })
//  In the demo:   fetch("https://convex.site/mock/printful/order", { ... })

const SITE_URL = process.env.CONVEX_SITE_URL!;

export const submitToProvider = internalAction({
  args: {
    orderId: v.string(),
    items: v.string(),
    item: v.string(),
    provider: v.string(),
  },
  handler: async (_ctx, { orderId, items, item, provider }) => {
    const providerUrl = `${SITE_URL}/mock/${provider}/order`;
    const callbackUrl = `${SITE_URL}/webhook/provider`;

    // Call the provider's API
    const response = await fetch(providerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        item,
        items,
        callbackUrl,
        // In production you'd include auth tokens, order details, etc.
      }),
    });

    if (!response.ok) {
      console.error(
        `Provider ${provider} returned ${response.status} for ${item}`,
      );
    }

    // That's it. The provider will call our webhook when it's done.
    // We don't wait — the STM retry/wake handles the rest.
  },
});
