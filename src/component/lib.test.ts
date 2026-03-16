/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

describe("STM component", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("init and read TVar", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "x", value: 42 });
    const val = await t.query(api.lib.readTVar, { key: "x" });
    expect(val).toBe(42);
  });

  test("commit writes atomically", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "a", value: 100 });
    await t.mutation(api.lib.init, { key: "b", value: 0 });

    await t.mutation(api.lib.commit, {
      writes: [
        { key: "a", value: 50 },
        { key: "b", value: 50 },
      ],
    });

    const a = await t.query(api.lib.readTVar, { key: "a" });
    const b = await t.query(api.lib.readTVar, { key: "b" });
    expect(a).toBe(50);
    expect(b).toBe(50);
  });

  test("read uninitialized TVar returns null", async () => {
    const t = initConvexTest();
    const val = await t.query(api.lib.readTVar, { key: "missing" });
    expect(val).toBeNull();
  });

  test("init does not overwrite existing value", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "x", value: 42 });
    await t.mutation(api.lib.init, { key: "x", value: 99 });
    const val = await t.query(api.lib.readTVar, { key: "x" });
    expect(val).toBe(42);
  });

  test("block returns false when value changed", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "x", value: 1 });

    // Block expecting value 999 (but actual is 1) — should return false
    const safeToBlock = await t.mutation(api.lib.block, {
      reads: [{ key: "x", expectedValue: 999 }],
      callbackHandle: "fake-handle",
    });
    expect(safeToBlock).toBe(false);
  });

  test("block returns true when values match", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "x", value: 1 });

    const safeToBlock = await t.mutation(api.lib.block, {
      reads: [{ key: "x", expectedValue: 1 }],
      callbackHandle: "fake-handle",
    });
    expect(safeToBlock).toBe(true);
  });

  test("readTVars returns multiple values", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "a", value: 10 });
    await t.mutation(api.lib.init, { key: "b", value: 20 });

    const result = await t.query(api.lib.readTVars, {
      keys: ["a", "b", "missing"],
    });
    expect(result).toEqual({ a: 10, b: 20, missing: null });
  });
});
