import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("Multi-item fulfillment", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("order is created with pending status", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    await t.mutation(api.example.placeOrder, { items: ["shirt", "mug"] });

    const orders = await t.query(api.example.listOrders, {});
    expect(orders.length).toBe(1);
    expect(orders[0].items).toEqual(["shirt", "mug"]);
  });

  test("providers have correct catalog", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    const providers = await t.query(api.example.readProviders, {});
    expect(providers["printful"].products).toEqual(["shirt", "mug"]);
    expect(providers["printify"].products).toEqual(["shirt", "poster"]);
    expect(providers["gooten"].products).toEqual(["mug", "poster"]);
  });
});
