import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("T-shirt fulfillment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("order is created with pending status", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    await t.mutation(api.example.orderShirt, {
      design: "Convex Logo Tee",
      size: "L",
    });

    const orders = await t.query(api.example.listOrders, {});
    expect(orders.length).toBe(1);
    // Order is either pending or submitted (depending on provider availability)
    expect(["pending", "submitted"]).toContain(orders[0].status);
  });

  test("toggling provider updates availability", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    let providers = await t.query(api.example.readProviders, {});
    expect(providers["printful"]).toBe(true);

    await t.mutation(api.example.toggleProvider, { provider: "printful" });

    providers = await t.query(api.example.readProviders, {});
    expect(providers["printful"]).toBe(false);
  });
});
