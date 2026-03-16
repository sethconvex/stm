import { describe, expect, test } from "vitest";
import { components, initConvexTest } from "./setup.test.js";

describe("STM component CRUD", () => {
  test("init and read TVar", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 42 });
    const val = await t.query(components.stm.lib.readTVar, { key: "x" });
    expect(val).toBe(42);
  });

  test("read uninitialized returns null", async () => {
    const t = initConvexTest();
    const val = await t.query(components.stm.lib.readTVar, { key: "nope" });
    expect(val).toBeNull();
  });

  test("init does not overwrite", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 1 });
    await t.mutation(components.stm.lib.init, { key: "x", value: 99 });
    expect(await t.query(components.stm.lib.readTVar, { key: "x" })).toBe(1);
  });

  test("commit writes atomically", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "a", value: 10 });
    await t.mutation(components.stm.lib.init, { key: "b", value: 20 });
    await t.mutation(components.stm.lib.commit, {
      writes: [
        { key: "a", value: 50 },
        { key: "b", value: 50 },
      ],
    });
    expect(await t.query(components.stm.lib.readTVar, { key: "a" })).toBe(50);
    expect(await t.query(components.stm.lib.readTVar, { key: "b" })).toBe(50);
  });

  test("readTVars returns multiple values", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "a", value: 1 });
    await t.mutation(components.stm.lib.init, { key: "b", value: 2 });
    const result = await t.query(components.stm.lib.readTVars, {
      keys: ["a", "b", "missing"],
    });
    expect(result).toEqual({ a: 1, b: 2, missing: null });
  });
});

describe("STM block", () => {
  test("returns true when values match", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 1 });
    const safe = await t.mutation(components.stm.lib.block, {
      reads: [{ key: "x", expectedValue: 1 }],
      callbackHandle: "fake",
    });
    expect(safe).toBe(true);
  });

  test("returns false when value changed", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 1 });
    const safe = await t.mutation(components.stm.lib.block, {
      reads: [{ key: "x", expectedValue: 999 }],
      callbackHandle: "fake",
    });
    expect(safe).toBe(false);
  });
});

describe("STM clearAll", () => {
  test("removes all tvars and waiters", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "a", value: 1 });
    await t.mutation(components.stm.lib.init, { key: "b", value: 2 });
    await t.mutation(components.stm.lib.clearAll, {});
    expect(await t.query(components.stm.lib.readTVar, { key: "a" })).toBeNull();
    expect(await t.query(components.stm.lib.readTVar, { key: "b" })).toBeNull();
  });
});

describe("STM cleanupKeys", () => {
  test("deletes specified tvars", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "keep", value: 1 });
    await t.mutation(components.stm.lib.init, { key: "delete-me", value: 2 });
    await t.mutation(components.stm.lib.cleanupKeys, { keys: ["delete-me"] });
    expect(await t.query(components.stm.lib.readTVar, { key: "keep" })).toBe(1);
    expect(await t.query(components.stm.lib.readTVar, { key: "delete-me" })).toBeNull();
  });
});
