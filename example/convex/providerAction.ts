import { internalAction } from "./_generated/server.js";
import { v } from "convex/values";

// Calls the mock provider's HTTP endpoint.
// The provider reads its own settings, processes, and webhooks back.

const SITE_URL = process.env.CONVEX_SITE_URL!;

export const submitToProvider = internalAction({
  args: {
    orderId: v.string(),
    items: v.string(),
    item: v.string(),
    provider: v.string(),
  },
  handler: async (_ctx, { orderId, items, item, provider }) => {
    await fetch(`${SITE_URL}/mock/${provider}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        item,
        items,
        callbackUrl: `${SITE_URL}/webhook/provider`,
      }),
    });
  },
});
