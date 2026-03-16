import { defineApp } from "convex/server";
import stm from "@convex-dev/stm/convex.config.js";

const app = defineApp();
app.use(stm);

export default app;
