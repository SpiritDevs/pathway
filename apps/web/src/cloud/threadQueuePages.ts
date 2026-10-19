import type { ThreadQueuePage, ThreadQueueThread } from "@spiritdevs/contracts/threadQueue";
import { queuedThreadKey } from "./threadQueueState";

/** Keep each reactive query bounded and replace downstream cursors when a page changes. */
export function subscribeThreadQueuePages(
  subscribe: (cursor: string | null, receive: (page: ThreadQueuePage) => void) => () => void,
  receive: (rows: readonly ThreadQueueThread[], hydrated: boolean) => void,
) {
  type Page = { cursor: string | null; value?: ThreadQueuePage; stop: () => void };
  const pages: Page[] = [];
  let active = true;
  function truncate(length: number) {
    for (const page of pages.splice(length)) page.stop();
  }
  function start(cursor: string | null, index: number) {
    const page: Page = { cursor, stop: () => {} };
    pages[index] = page;
    const stop = subscribe(cursor, (value) => {
      if (!active || pages[index] !== page) return;
      page.value = value;
      const next = pages[index + 1];
      if (value.isDone || (next && next.cursor !== value.continueCursor)) truncate(index + 1);
      const rows = new Map(
        pages.flatMap((entry) => entry.value?.page ?? []).map((row) => [queuedThreadKey(row), row]),
      );
      receive([...rows.values()], pages.at(-1)?.value?.isDone === true);
      if (!value.isDone && !pages[index + 1]) start(value.continueCursor, index + 1);
    });
    page.stop = stop;
    if (!active || pages[index] !== page) stop();
  }
  start(null, 0);
  return () => {
    active = false;
    truncate(0);
  };
}
