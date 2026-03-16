/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    lib: {
      block: FunctionReference<
        "mutation",
        "internal",
        {
          callbackArgs?: any;
          callbackHandle: string;
          reads: Array<{ expectedValue: any; key: string }>;
        },
        boolean,
        Name
      >;
      cleanupKeys: FunctionReference<
        "mutation",
        "internal",
        { keys: Array<string> },
        null,
        Name
      >;
      cleanupPrefix: FunctionReference<
        "mutation",
        "internal",
        { prefix: string },
        null,
        Name
      >;
      clearAll: FunctionReference<"mutation", "internal", {}, null, Name>;
      commit: FunctionReference<
        "mutation",
        "internal",
        { writes: Array<{ key: string; value: any }> },
        null,
        Name
      >;
      init: FunctionReference<
        "mutation",
        "internal",
        { key: string; value: any },
        null,
        Name
      >;
      readTVar: FunctionReference<
        "query",
        "internal",
        { key: string },
        any,
        Name
      >;
      readTVars: FunctionReference<
        "query",
        "internal",
        { keys: Array<string> },
        any,
        Name
      >;
      scheduleTimeout: FunctionReference<
        "mutation",
        "internal",
        { key: string; ms: number },
        null,
        Name
      >;
    };
  };
