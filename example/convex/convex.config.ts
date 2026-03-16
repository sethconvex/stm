import { defineApp } from "convex/server";
import stm from "@convex-dev/stm/convex.config.js";
import selfHosting from "@convex-dev/static-hosting/convex.config.js";

const app = defineApp();
app.use(stm);
app.use(selfHosting);

export default app;
