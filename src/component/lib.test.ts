/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

describe("TVar CRUD", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("init and read", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "x", value: 42 });
    expect(await t.query(api.lib.readTVar, { key: "x" })).toBe(42);
  });

  test("init is idempotent", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "x", value: 1 });
    await t.mutation(api.lib.init, { key: "x", value: 99 });
    expect(await t.query(api.lib.readTVar, { key: "x" })).toBe(1);
  });

  test("read uninitialized returns null", async () => {
    const t = initConvexTest();
    expect(await t.query(api.lib.readTVar, { key: "missing" })).toBeNull();
  });

  test("readTVars batch", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "a", value: 10 });
    await t.mutation(api.lib.init, { key: "b", value: 20 });
    const result = await t.query(api.lib.readTVars, { keys: ["a", "b", "c"] });
    expect(result).toEqual({ a: 10, b: 20, c: null });
  });
});

describe("commit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("writes multiple TVars atomically", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "a", value: 0 });
    await t.mutation(api.lib.init, { key: "b", value: 0 });
    await t.mutation(api.lib.commit, {
      writes: [{ key: "a", value: 50 }, { key: "b", value: 50 }],
    });
    expect(await t.query(api.lib.readTVar, { key: "a" })).toBe(50);
    expect(await t.query(api.lib.readTVar, { key: "b" })).toBe(50);
  });

  test("upserts — creates if not exists", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.commit, { writes: [{ key: "new", value: "hi" }] });
    expect(await t.query(api.lib.readTVar, { key: "new" })).toBe("hi");
  });
});

describe("block — revalidation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("returns true when values match (safe to block)", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "x", value: 5 });
    const safe = await t.mutation(api.lib.block, {
      reads: [{ key: "x", expectedValue: 5 }],
      callbackHandle: "fake-handle",
    });
    expect(safe).toBe(true);
  });

  test("returns false when value changed (stale read)", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "x", value: 5 });
    const safe = await t.mutation(api.lib.block, {
      reads: [{ key: "x", expectedValue: 999 }],
      callbackHandle: "fake-handle",
    });
    expect(safe).toBe(false);
  });

  test("returns false with multiple reads if any changed", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "a", value: 1 });
    await t.mutation(api.lib.init, { key: "b", value: 2 });
    const safe = await t.mutation(api.lib.block, {
      reads: [
        { key: "a", expectedValue: 1 },
        { key: "b", expectedValue: 999 }, // stale
      ],
      callbackHandle: "fake-handle",
    });
    expect(safe).toBe(false);
  });
});

describe("clearAll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("removes all tvars", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "a", value: 1 });
    await t.mutation(api.lib.init, { key: "b", value: 2 });
    await t.mutation(api.lib.clearAll, {});
    expect(await t.query(api.lib.readTVar, { key: "a" })).toBeNull();
    expect(await t.query(api.lib.readTVar, { key: "b" })).toBeNull();
  });
});

describe("cleanupKeys", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("deletes specified keys only", async () => {
    const t = initConvexTest();
    await t.mutation(api.lib.init, { key: "keep", value: 1 });
    await t.mutation(api.lib.init, { key: "remove", value: 2 });
    await t.mutation(api.lib.cleanupKeys, { keys: ["remove"] });
    expect(await t.query(api.lib.readTVar, { key: "keep" })).toBe(1);
    expect(await t.query(api.lib.readTVar, { key: "remove" })).toBeNull();
  });
});

describe("scheduleTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("creates TVar on fire", async () => {
    const t = initConvexTest();
    // First create a waiter so fireTimeout doesn't no-op
    await t.mutation(api.lib.block, {
      reads: [{ key: "__timeout:test", expectedValue: null }],
      callbackHandle: "fake",
    });
    await t.mutation(api.lib.scheduleTimeout, { key: "__timeout:test", ms: 100 });
    // Advance time to trigger the scheduled fireTimeout
    await vi.advanceTimersByTimeAsync(200);
    expect(await t.query(api.lib.readTVar, { key: "__timeout:test" })).toBe(true);
  });
});
