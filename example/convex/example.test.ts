import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api, internal } from "./_generated/api";

describe("Order lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("placeOrder creates order with pending status", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});
    await t.mutation(api.example.placeOrder, { items: ["shirt", "mug"] });
    const orders = await t.query(api.example.listOrders, {});
    expect(orders.length).toBe(1);
    expect(orders[0].items).toEqual(["shirt", "mug"]);
    expect(["pending", "submitted"]).toContain(orders[0].status);
  });

  test("providers have correct catalog", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});
    const providers = await t.query(api.example.readProviders, {});
    expect(providers["printful"].products).toEqual(["shirt", "mug"]);
    expect(providers["printify"].products).toEqual(["shirt", "poster"]);
    expect(providers["gooten"].products).toEqual(["mug", "poster"]);
  });

  test("all providers start online", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});
    const providers = await t.query(api.example.readProviders, {});
    expect(providers["printful"].online).toBe(true);
    expect(providers["printify"].online).toBe(true);
    expect(providers["gooten"].online).toBe(true);
  });

  test("toggleProvider takes provider offline and back", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    await t.mutation(api.example.toggleProvider, { provider: "printful" });
    let providers = await t.query(api.example.readProviders, {});
    expect(providers["printful"].online).toBe(false);

    await t.mutation(api.example.toggleProvider, { provider: "printful" });
    providers = await t.query(api.example.readProviders, {});
    expect(providers["printful"].online).toBe(true);
  });

  test("setAvailable sets provider availability", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    await t.mutation(api.example.setAvailable, { provider: "gooten", available: false });
    const providers = await t.query(api.example.readProviders, {});
    expect(providers["gooten"].online).toBe(false);
  });

  test("setup clears orders", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});
    await t.mutation(api.example.placeOrder, { items: ["shirt"] });
    await t.mutation(api.example.placeOrder, { items: ["mug"] });

    let orders = await t.query(api.example.listOrders, {});
    expect(orders.length).toBe(2);

    await t.mutation(api.example.setup, {});
    orders = await t.query(api.example.listOrders, {});
    expect(orders.length).toBe(0);
  });

  test("webhook records attempt on order", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});
    const orderId = await t.mutation(api.example.placeOrder, { items: ["shirt"] });

    // Simulate a webhook response
    await t.mutation(internal.example.handleWebhook, {
      orderId: orderId as string,
      items: JSON.stringify(["shirt"]),
      item: "shirt",
      provider: "printful",
      result: "accepted",
    });

    const orders = await t.query(api.example.listOrders, {});
    const order = orders.find((o: any) => o._id === orderId);
    expect(order).toBeDefined();
    expect(order!.attempts.length).toBeGreaterThan(0);
    const accepted = order!.attempts.find(
      (a: any) => a.provider === "printful" && a.result === "accepted",
    );
    expect(accepted).toBeDefined();
  });
});
