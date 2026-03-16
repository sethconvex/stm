import { internalAction } from "./_generated/server.js";
import { v } from "convex/values";

// Step 2: IO — call the provider's API via fetch.
// The provider processes and webhooks back accepted/rejected.

const SITE_URL = process.env.CONVEX_SITE_URL!;

export const submitToProvider = internalAction({
  args: { orderId: v.string(), items: v.string(), item: v.string(), provider: v.string() },
  handler: async (_ctx, { orderId, items, item, provider }) => {
    await fetch(`${SITE_URL}/mock/${provider}/order`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId, item, items,
        callbackUrl: `${SITE_URL}/webhook/provider`,
      }),
    });
  },
});
