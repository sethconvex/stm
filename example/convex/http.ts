import { httpRouter } from "convex/server";
import { registerStaticRoutes } from "@convex-dev/static-hosting";
import { components } from "./_generated/api";
import { webhookHandler } from "./example.js";
import { printfulOrder, printifyOrder, gootenOrder } from "./mockProviders/handlers.js";

const http = httpRouter();

// Our webhook — providers call this with accepted/rejected
http.route({ path: "/webhook/provider", method: "POST", handler: webhookHandler });

// Mock providers
http.route({ path: "/mock/printful/order", method: "POST", handler: printfulOrder });
http.route({ path: "/mock/printify/order", method: "POST", handler: printifyOrder });
http.route({ path: "/mock/gooten/order", method: "POST", handler: gootenOrder });

// Static hosting — serves the built frontend
registerStaticRoutes(http, components.selfHosting);

export default http;
