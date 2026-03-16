import { internalAction } from "./_generated/server.js";
import { v } from "convex/values";

// Submit an order to a mock provider via HTTP.
// The provider processes and calls our webhook back.

const SITE_URL = process.env.CONVEX_SITE_URL!;

export const submitToProvider = internalAction({
  args: {
    orderId: v.string(),
    items: v.string(),
    item: v.string(),
    provider: v.string(),
    failRate: v.optional(v.number()),
  },
  handler: async (_ctx, { orderId, items, item, provider, failRate }) => {
    const providerUrl = `${SITE_URL}/mock/${provider}/order`;
    const callbackUrl = `${SITE_URL}/webhook/provider`;

    await fetch(providerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        item,
        items,
        callbackUrl,
        failRate: failRate ?? 30,
      }),
    });
  },
});
