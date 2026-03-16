import { describe, expect, test } from "vitest";
import { components, initConvexTest } from "./setup.test.js";

describe("STM client tests", () => {
  test("should commit TVar writes atomically", async () => {
    const t = initConvexTest();

    // Init TVars
    await t.mutation(components.stm.lib.init, {
      key: "a",
      value: 100,
    });
    await t.mutation(components.stm.lib.init, {
      key: "b",
      value: 0,
    });

    // Commit a transfer
    await t.mutation(components.stm.lib.commit, {
      writes: [
        { key: "a", value: 50 },
        { key: "b", value: 50 },
      ],
    });

    // Verify
    const a = await t.query(components.stm.lib.readTVar, { key: "a" });
    const b = await t.query(components.stm.lib.readTVar, { key: "b" });
    expect(a).toBe(50);
    expect(b).toBe(50);
  });

  test("should read null for uninitialized TVar", async () => {
    const t = initConvexTest();
    const val = await t.query(components.stm.lib.readTVar, {
      key: "nonexistent",
    });
    expect(val).toBeNull();
  });

  test("init should not overwrite existing value", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 42 });
    await t.mutation(components.stm.lib.init, { key: "x", value: 99 });
    const val = await t.query(components.stm.lib.readTVar, { key: "x" });
    expect(val).toBe(42);
  });
});
