/// <reference types="vite/client" />
import { describe, expect, test } from "vitest";
import { components, initConvexTest } from "./setup.test.js";
import { STM } from "./index.js";

const stm = new STM(components.stm);

describe("STM.atomic — commit and retry", () => {
  test("commits writes on success", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 0 });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        const val = (await tx.read("x")) as number;
        tx.write("x", val + 10);
        return "done";
      });
    });

    expect(result).toEqual({ committed: true, value: "done" });
    expect(await t.query(components.stm.lib.readTVar, { key: "x" })).toBe(10);
  });

  test("returns committed:false on retry", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 0 });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        const val = await tx.read("x");
        if (val === 0) tx.retry();
        return "done";
      });
    });

    expect(result.committed).toBe(false);
    expect(await t.query(components.stm.lib.readTVar, { key: "x" })).toBe(0);
  });

  test("discards writes on retry", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 1 });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        tx.write("x", 999);
        tx.retry();
      });
    });

    expect(result.committed).toBe(false);
    expect(await t.query(components.stm.lib.readTVar, { key: "x" })).toBe(1);
  });

  test("discards writes on exception (abort semantics)", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 1 });

    let caught = false;
    try {
      await t.run(async (ctx) => {
        return await stm.atomic(ctx, async (tx) => {
          tx.write("x", 999);
          throw new Error("boom");
        });
      });
    } catch {
      caught = true;
    }

    expect(caught).toBe(true);
    expect(await t.query(components.stm.lib.readTVar, { key: "x" })).toBe(1);
  });
});

describe("STM read-your-writes", () => {
  test("read sees own writes within transaction", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 0 });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        tx.write("x", 42);
        return await tx.read("x");
      });
    });

    expect(result).toEqual({ committed: true, value: 42 });
  });
});

describe("STM orElse", () => {
  test("returns first branch if it succeeds", async () => {
    const t = initConvexTest();
    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        return await tx.orElse(
          async () => "first",
          async () => "second",
        );
      });
    });
    expect(result).toEqual({ committed: true, value: "first" });
  });

  test("falls back to second branch on retry", async () => {
    const t = initConvexTest();
    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        return await tx.orElse(
          async () => { tx.retry(); return "never"; },
          async () => "second",
        );
      });
    });
    expect(result).toEqual({ committed: true, value: "second" });
  });

  test("discards first branch writes on retry", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "x", value: 0 });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        return await tx.orElse(
          async () => { tx.write("x", 999); tx.retry(); return "never"; },
          async () => await tx.read("x"),  // should see 0, not 999
        );
      });
    });

    expect(result).toEqual({ committed: true, value: 0 });
    expect(await t.query(components.stm.lib.readTVar, { key: "x" })).toBe(0);
  });

  test("both branches retry → transaction retries", async () => {
    const t = initConvexTest();
    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        return await tx.orElse(
          async () => { tx.retry(); return "never"; },
          async () => { tx.retry(); return "never"; },
        );
      });
    });
    expect(result.committed).toBe(false);
  });
});

describe("STM select", () => {
  test("returns first successful branch", async () => {
    const t = initConvexTest();
    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        return await tx.select(
          async () => "a",
          async () => "b",
          async () => "c",
        );
      });
    });
    expect(result).toEqual({ committed: true, value: "a" });
  });

  test("skips retrying branches", async () => {
    const t = initConvexTest();
    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        return await tx.select(
          async () => { tx.retry(); return "never"; },
          async () => { tx.retry(); return "never"; },
          async () => "c",
        );
      });
    });
    expect(result).toEqual({ committed: true, value: "c" });
  });

  test("single branch works", async () => {
    const t = initConvexTest();
    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        return await tx.select(async () => "only");
      });
    });
    expect(result).toEqual({ committed: true, value: "only" });
  });

  test("all branches retry → transaction retries", async () => {
    const t = initConvexTest();
    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        return await tx.select(
          async () => { tx.retry(); return "never"; },
          async () => { tx.retry(); return "never"; },
        );
      });
    });
    expect(result.committed).toBe(false);
  });
});

describe("STM afterCommit", () => {
  test("runs after successful commit", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "flag", value: false });

    await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        tx.afterCommit(async (innerCtx) => {
          await innerCtx.runMutation(components.stm.lib.commit, {
            writes: [{ key: "flag", value: true }],
          });
        });
        return "done";
      });
    });

    expect(await t.query(components.stm.lib.readTVar, { key: "flag" })).toBe(true);
  });

  test("discarded on retry (not run)", async () => {
    const t = initConvexTest();
    await t.mutation(components.stm.lib.init, { key: "flag", value: false });

    await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        tx.afterCommit(async (innerCtx) => {
          await innerCtx.runMutation(components.stm.lib.commit, {
            writes: [{ key: "flag", value: true }],
          });
        });
        tx.retry();
      });
    });

    expect(await t.query(components.stm.lib.readTVar, { key: "flag" })).toBe(false);
  });
});

describe("STM TMVar", () => {
  test("take from full returns value and empties", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => { await stm.initTMVarFull(ctx, "slot", 42); });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => await tx.take("slot"));
    });
    expect(result).toEqual({ committed: true, value: 42 });
  });

  test("take from empty retries", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => { await stm.initTMVar(ctx, "slot"); });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => await tx.take("slot"));
    });
    expect(result.committed).toBe(false);
  });

  test("put to empty succeeds", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => { await stm.initTMVar(ctx, "slot"); });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        await tx.put("slot", "hello");
        return "done";
      });
    });
    expect(result).toEqual({ committed: true, value: "done" });
  });

  test("put to full retries", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => { await stm.initTMVarFull(ctx, "slot", "x"); });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => {
        await tx.put("slot", "nope");
        return "done";
      });
    });
    expect(result.committed).toBe(false);
  });

  test("tryTake from full returns value", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => { await stm.initTMVarFull(ctx, "slot", 99); });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => await tx.tryTake("slot"));
    });
    expect(result).toEqual({ committed: true, value: { value: 99 } });
  });

  test("tryTake from empty returns null", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => { await stm.initTMVar(ctx, "slot"); });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => await tx.tryTake("slot"));
    });
    expect(result).toEqual({ committed: true, value: null });
  });

  test("tryPut to empty returns true", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => { await stm.initTMVar(ctx, "slot"); });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => await tx.tryPut("slot", "hi"));
    });
    expect(result).toEqual({ committed: true, value: true });
  });

  test("tryPut to full returns false", async () => {
    const t = initConvexTest();
    await t.run(async (ctx) => { await stm.initTMVarFull(ctx, "slot", "x"); });

    const result = await t.run(async (ctx) => {
      return await stm.atomic(ctx, async (tx) => await tx.tryPut("slot", "n"));
    });
    expect(result).toEqual({ committed: true, value: false });
  });
});
