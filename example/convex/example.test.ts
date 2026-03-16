import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { initConvexTest } from "./setup.test";
import { api } from "./_generated/api";

describe("STM example", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  test("setup and atomic move conserves total", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    const before = await t.query(api.example.readAll, {});
    expect(before.gold + before.silver + before.bronze).toBe(140);

    await t.mutation(api.example.atomicMove, {
      from: "bronze",
      to: "gold",
      amount: 5,
    });

    const after = await t.query(api.example.readAll, {});
    expect(after.gold).toBe(15);
    expect(after.bronze).toBe(95);
    expect(after.gold + after.silver + after.bronze).toBe(140);
  });

  test("orElse takes gold first", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    const result = await t.mutation(api.example.takeBest, { amount: 1 });
    expect(result.committed).toBe(true);
    expect((result as any).value).toBe("gold");

    const after = await t.query(api.example.readAll, {});
    expect(after.gold).toBe(9);
  });

  test("orElse falls back when gold exhausted", async () => {
    const t = initConvexTest();
    await t.mutation(api.example.setup, {});

    // Drain all gold
    await t.mutation(api.example.takeBest, { amount: 10 });
    const mid = await t.query(api.example.readAll, {});
    expect(mid.gold).toBe(0);

    // Now takeBest should fall back to silver
    const result = await t.mutation(api.example.takeBest, { amount: 1 });
    expect(result.committed).toBe(true);
    expect((result as any).value).toBe("silver");
  });
});
