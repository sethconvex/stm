import { httpAction } from "../_generated/server.js";
import { internal } from "../_generated/api.js";

// ═══════════════════════════════════════════════════════════════════════
//  Mock print-on-demand providers
// ═══════════════════════════════════════════════════════════════════════
//  Phase 1: POST /mock/{provider}/order
//    → Provider processes, webhooks back "ready" or "rejected"
//
//  Phase 2: POST /mock/{provider}/confirm
//    → We tell the provider CONFIRM or CANCEL
//    → 200 = acknowledged
// ═══════════════════════════════════════════════════════════════════════

async function handleOrder(ctx: any, providerName: string, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    orderId: string; item: string; items: string; callbackUrl: string;
  };

  const { orderId, item, items, callbackUrl } = body;
  if (!orderId || !item || !callbackUrl) {
    return new Response(JSON.stringify({ error: "Missing fields" }), { status: 400 });
  }

  // Read our own settings
  const settings = await ctx.runQuery(internal.mockProviders.settings.get, { provider: providerName });
  const failRate = settings?.failRate ?? 30;
  const maxDelay = settings?.maxDelay ?? 5000;

  // Simulate processing time
  await new Promise((r) => setTimeout(r, 500 + Math.random() * maxDelay));

  // Decide: ready or rejected
  const accepted = Math.random() * 100 >= failRate;
  const result = accepted ? "ready" : "rejected";

  // Webhook back
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

async function handleConfirm(providerName: string, request: Request): Promise<Response> {
  const body = (await request.json()) as {
    orderId: string; item: string; action: "CONFIRM" | "CANCEL";
  };

  // In a real provider, CONFIRM would start printing.
  // CANCEL would release the reservation.
  console.log(`${providerName}: ${body.action} for ${body.item} (order ${body.orderId})`);

  return new Response(
    JSON.stringify({ provider: providerName, action: body.action, status: "acknowledged" }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

// Order endpoints
export const printfulOrder = httpAction(async (ctx, req) => handleOrder(ctx, "printful", req));
export const printifyOrder = httpAction(async (ctx, req) => handleOrder(ctx, "printify", req));
export const gootenOrder = httpAction(async (ctx, req) => handleOrder(ctx, "gooten", req));

// Confirm/cancel endpoints
export const printfulConfirm = httpAction(async (_ctx, req) => handleConfirm("printful", req));
export const printifyConfirm = httpAction(async (_ctx, req) => handleConfirm("printify", req));
export const gootenConfirm = httpAction(async (_ctx, req) => handleConfirm("gooten", req));
