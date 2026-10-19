import type { RegisteredMutation, RegisteredQuery } from "convex/server";
import type { MutationCtx } from "../convex/_generated/server.js";

/** Invoke the registered function with an instrumented real database inside convex-test's transaction. */
export function functionHandler<
  Visibility extends "public" | "internal",
  Args extends Record<string, unknown>,
  Result,
>(
  registered:
    | RegisteredMutation<Visibility, Args, Result>
    | RegisteredQuery<Visibility, Args, Result>,
): (ctx: MutationCtx, args: Args) => Result {
  const handler: unknown = Reflect.get(registered, "_handler");
  if (typeof handler !== "function") throw new Error("Missing Convex test handler");
  return (ctx, args) => Reflect.apply(handler, undefined, [ctx, args]) as Result;
}

/** Counts documents returned by real convex-test reads, rather than mocking query results. */
export function measureDatabaseReads<T extends object>(db: T) {
  const documents = new Map<string, number>();
  let bytes = 0;
  const record = (table: string, value: unknown) => {
    const rows = Array.isArray(value) ? value : value === null ? [] : [value];
    documents.set(table, (documents.get(table) ?? 0) + rows.length);
    bytes += new TextEncoder().encode(JSON.stringify(rows)).byteLength;
  };
  const wrap = <U extends object>(target: U, table: string): U =>
    new Proxy(target, {
      get(object, key) {
        const value: unknown = Reflect.get(object, key);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, object, args);
          if (["get", "collect", "take", "first", "unique", "paginate"].includes(String(key))) {
            return Promise.resolve(result).then((rows) => {
              record(
                table,
                key === "paginate" && rows !== null && typeof rows === "object"
                  ? Reflect.get(rows, "page")
                  : rows,
              );
              return rows;
            });
          }
          if (result !== null && typeof result === "object" && !(result instanceof Promise)) {
            return wrap(result, key === "query" ? String(args[0]) : table);
          }
          return result;
        };
      },
    });
  return { db: wrap(db, "get"), documents, bytes: () => bytes };
}
