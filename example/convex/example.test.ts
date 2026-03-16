import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("Warehouse ordering", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("order completes immediately when in stock", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});
    await t.mutation(api.example.restock, { warehouse: "us-west", amount: 5 });

    const r = await t.mutation(api.example.placeOrder, {
      warehouse: "us-west",
      amount: 1,
    });
    expect(r.immediate).toBe(true);

    const stock = await t.query(api.example.readStock, {});
    expect(stock["us-west"]).toBe(4);
  });

  test("order goes pending when out of stock", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    const r = await t.mutation(api.example.placeOrder, {
      warehouse: "us-west",
      amount: 1,
    });
    expect(r.immediate).toBe(false);

    const orders = await t.query(api.example.listOrders, {});
    expect(orders[0].status).toBe("pending");
  });

  test("select picks first available warehouse", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});
    // Only EU has stock
    await t.mutation(api.example.restock, {
      warehouse: "eu-central",
      amount: 3,
    });

    const r = await t.mutation(api.example.buyFromAny, { amount: 1 });
    expect(r.immediate).toBe(true);

    const stock = await t.query(api.example.readStock, {});
    expect(stock["eu-central"]).toBe(2);
  });

  test("select goes pending when all empty", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    const r = await t.mutation(api.example.buyFromAny, { amount: 1 });
    expect(r.immediate).toBe(false);
  });
});
