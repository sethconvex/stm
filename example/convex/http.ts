import { httpRouter } from "convex/server";
import { webhookHandler } from "./example.js";
import {
  printfulOrder, printifyOrder, gootenOrder,
  printfulConfirm, printifyConfirm, gootenConfirm,
} from "./mockProviders/handlers.js";

const http = httpRouter();

// Our webhook — providers call this with "ready" or "rejected"
http.route({ path: "/webhook/provider", method: "POST", handler: webhookHandler });

// Mock provider endpoints — Phase 1: submit order
http.route({ path: "/mock/printful/order", method: "POST", handler: printfulOrder });
http.route({ path: "/mock/printify/order", method: "POST", handler: printifyOrder });
http.route({ path: "/mock/gooten/order", method: "POST", handler: gootenOrder });

// Mock provider endpoints — Phase 2: confirm or cancel
http.route({ path: "/mock/printful/confirm", method: "POST", handler: printfulConfirm });
http.route({ path: "/mock/printify/confirm", method: "POST", handler: printifyConfirm });
http.route({ path: "/mock/gooten/confirm", method: "POST", handler: gootenConfirm });

export default http;
