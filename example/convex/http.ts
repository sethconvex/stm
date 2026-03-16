import { httpRouter } from "convex/server";
import { webhookHandler } from "./example.js";
import { printful, printify, gooten } from "./mockProviders/handlers.js";

const http = httpRouter();

// ── Our webhook — providers call this with their result ───────────────
http.route({
  path: "/webhook/provider",
  method: "POST",
  handler: webhookHandler,
});

// ── Mock provider endpoints — simulate Printful/Printify/Gooten ──────
// In production, these would be real external services.
// Our action calls fetch() to these, they process and call our webhook.
http.route({ path: "/mock/printful/order", method: "POST", handler: printful });
http.route({ path: "/mock/printify/order", method: "POST", handler: printify });
http.route({ path: "/mock/gooten/order", method: "POST", handler: gooten });

export default http;
