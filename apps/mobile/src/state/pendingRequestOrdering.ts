import type { RuntimeRequestId } from "@t3tools/contracts";

export function sortPendingRequestsOldestFirst<
  Request extends { readonly requestId: RuntimeRequestId; readonly createdAt: string },
>(requests: ReadonlyArray<Request>): ReadonlyArray<Request> {
  return [...requests].sort((left, right) => {
    const timestampOrder = left.createdAt.localeCompare(right.createdAt);
    return timestampOrder !== 0
      ? timestampOrder
      : String(left.requestId).localeCompare(String(right.requestId));
  });
}
