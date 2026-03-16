import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("STM retry-wake demo", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  test("restock then buy completes immediately", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    // Restock first
    await t.mutation(api.example.restock, { item: "widgets", amount: 5 });
    const stock = await t.query(api.example.readStock, {});
    expect(stock.widgets).toBe(5);

    // Buy succeeds immediately
    const result = await t.mutation(api.example.placeOrder, {
      item: "widgets",
      amount: 1,
    });
    expect(result.immediate).toBe(true);

    const stockAfter = await t.query(api.example.readStock, {});
    expect(stockAfter.widgets).toBe(4);
  });

  test("buy with no stock creates pending order", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    // No stock — order goes pending
    const result = await t.mutation(api.example.placeOrder, {
      item: "widgets",
      amount: 1,
    });
    expect(result.immediate).toBe(false);

    const orders = await t.query(api.example.listOrders, {});
    expect(orders.length).toBe(1);
    expect(orders[0].status).toBe("pending");
  });
});
