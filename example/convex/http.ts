import { httpRouter } from "convex/server";
import { webhookHandler } from "./example.js";

const http = httpRouter();

// Real providers (Printful, Printify, etc.) would POST to this endpoint
// with { orderId, provider, result: "accepted"|"rejected" }
http.route({
  path: "/webhook/provider",
  method: "POST",
  handler: webhookHandler,
});

export default http;
