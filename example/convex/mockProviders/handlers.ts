import { httpAction } from "../_generated/server.js";
import { internal } from "../_generated/api.js";

// ═══════════════════════════════════════════════════════════════════════
//  Mock print-on-demand providers
// ═══════════════════════════════════════════════════════════════════════
//  Simulates external provider APIs. Each provider:
//  1. Receives a POST with { orderId, item, callbackUrl }
//  2. Reads its own settings from the DB (fail rate, max delay)
//  3. Simulates processing time
//  4. POSTs back to callbackUrl with the result
//
//  They know nothing about STM or TVars.
// ═══════════════════════════════════════════════════════════════════════

async function handleProviderRequest(
  ctx: any,
  providerName: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as {
    orderId: string;
    item: string;
    items: string;
    callbackUrl: string;
  };

  const { orderId, item, items, callbackUrl } = body;
  if (!orderId || !item || !callbackUrl) {
    return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400 });
  }

  // Read our own settings from the DB (plain query, not TVar)
  const settings = await ctx.runQuery(
    internal.mockProviders.settings.get,
    { provider: providerName },
  );
  const failRate = settings?.failRate ?? 30;
  const maxDelay = settings?.maxDelay ?? 5000;

  // Simulate processing time
  const delay = 500 + Math.random() * maxDelay;
  await new Promise((r) => setTimeout(r, delay));

  // Decide accept or reject
  const accepted = Math.random() * 100 >= failRate;
  const result = accepted ? "ready" : "rejected";

  // Call back the webhook
  try {
    await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId, item, items, provider: providerName, result }),
    });
  } catch (e) {
    console.error(`${providerName}: webhook callback failed`, e);
  }

  return new Response(
    JSON.stringify({ provider: providerName, status: "processing" }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
}

export const printful = httpAction(async (ctx, request) =>
  handleProviderRequest(ctx, "printful", request),
);
export const printify = httpAction(async (ctx, request) =>
  handleProviderRequest(ctx, "printify", request),
);
export const gooten = httpAction(async (ctx, request) =>
  handleProviderRequest(ctx, "gooten", request),
);
