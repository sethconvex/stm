import { httpAction } from "../_generated/server.js";

// ═══════════════════════════════════════════════════════════════════════
//  Mock print-on-demand providers
// ═══════════════════════════════════════════════════════════════════════
//
//  These simulate external provider APIs. In production, these would be
//  Printful, Printify, Gooten etc. — completely separate services.
//
//  Each provider:
//  1. Receives a POST with { orderId, item, callbackUrl }
//  2. Simulates processing time (1-5s)
//  3. Decides accept/reject (based on failRate query param)
//  4. POSTs back to callbackUrl with the result (the webhook)
//
//  They know nothing about STM, TVars, or Convex internals.
//  They just receive HTTP requests and send HTTP callbacks.
// ═══════════════════════════════════════════════════════════════════════

async function handleProviderRequest(
  providerName: string,
  request: Request,
): Promise<Response> {
  const body = (await request.json()) as {
    orderId: string;
    item: string;
    items: string;
    callbackUrl: string;
    failRate?: number;
  };

  const { orderId, item, items, callbackUrl, failRate = 30 } = body;

  if (!orderId || !item || !callbackUrl) {
    return new Response(
      JSON.stringify({ error: "Missing orderId, item, or callbackUrl" }),
      { status: 400 },
    );
  }

  // Acknowledge receipt immediately (like a real provider would)
  // The actual processing happens async via the scheduled callback below.
  // We use waitUntil-style by doing the work before responding.

  // Simulate processing time (1-5s)
  const delay = 1000 + Math.random() * 4000;
  await new Promise((r) => setTimeout(r, delay));

  // Decide: accept or reject
  const accepted = Math.random() * 100 >= failRate;
  const result = accepted ? "ready" : "rejected";

  // Call back the webhook with our decision
  try {
    await fetch(callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        item,
        items,
        provider: providerName,
        result,
      }),
    });
  } catch (e) {
    // Webhook failed — in production you'd retry
    console.error(`${providerName}: webhook callback failed`, e);
  }

  return new Response(
    JSON.stringify({
      provider: providerName,
      orderId,
      item,
      status: "processing",
      estimatedResult: `${delay.toFixed(0)}ms`,
    }),
    { status: 202, headers: { "Content-Type": "application/json" } },
  );
}

// Each provider gets its own endpoint
export const printful = httpAction(async (_ctx, request) => {
  return handleProviderRequest("printful", request);
});

export const printify = httpAction(async (_ctx, request) => {
  return handleProviderRequest("printify", request);
});

export const gooten = httpAction(async (_ctx, request) => {
  return handleProviderRequest("gooten", request);
});
