import { httpAction } from "../_generated/server.js";
import { internal } from "../_generated/api.js";

// Mock provider: receives order, simulates delay, webhooks back accepted/rejected.
// Reads its own settings (failRate, maxDelay) from the DB.

async function handleOrder(ctx: any, providerName: string, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    orderId: string; item: string; items: string; callbackUrl: string;
  };

  if (!body.orderId || !body.item || !body.callbackUrl) {
    return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400 });
  }

  const settings = await ctx.runQuery(internal.mockProviders.settings.get, { provider: providerName });
  const failRate = settings?.failRate ?? 30;
  const maxDelay = settings?.maxDelay ?? 5000;

  // Simulate processing
  await new Promise((r) => setTimeout(r, 500 + Math.random() * maxDelay));

  const result = Math.random() * 100 >= failRate ? "accepted" : "rejected";

  // Webhook back
  try {
    await fetch(body.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId: body.orderId, item: body.item, items: body.items,
        provider: providerName, result,
      }),
    });
  } catch (e) {
    console.error(`${providerName}: webhook failed`, e);
  }

  return new Response(JSON.stringify({ provider: providerName, status: "processing" }), {
    status: 202, headers: { "Content-Type": "application/json" },
  });
}

export const printfulOrder = httpAction(async (ctx, req) => handleOrder(ctx, "printful", req));
export const printifyOrder = httpAction(async (ctx, req) => handleOrder(ctx, "printify", req));
export const gootenOrder = httpAction(async (ctx, req) => handleOrder(ctx, "gooten", req));
