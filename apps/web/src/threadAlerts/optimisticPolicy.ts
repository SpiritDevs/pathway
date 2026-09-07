import { ALERT_EVENT_KEYS, type AlertPolicyRow } from "@spiritdevs/contracts/threadAlerts";

const keyOf = (row: Pick<AlertPolicyRow, "scopeKind" | "scopeKey">) =>
  `${row.scopeKind}:${row.scopeKey}`;

/** Keeps the latest local choice visible until its cloud row matches. */
export function createOptimisticAlertPolicies(publish: (rows: readonly AlertPolicyRow[]) => void) {
  let remote: readonly AlertPolicyRow[] = [];
  let revision = 0;
  const pending = new Map<
    string,
    { row: AlertPolicyRow; revision: number; settled: boolean; failed: boolean }
  >();
  const emit = () => {
    const rows = new Map(remote.map((row) => [keyOf(row), row]));
    for (const [key, value] of pending) {
      if (ALERT_EVENT_KEYS.every((event) => value.row.choices[event] === undefined))
        rows.delete(key);
      else rows.set(key, value.row);
    }
    publish([...rows.values()]);
  };
  const reconcile = () => {
    for (const [key, value] of pending) {
      const actual = remote.find((row) => keyOf(row) === key);
      if (
        value.settled &&
        ALERT_EVENT_KEYS.every((event) => actual?.choices[event] === value.row.choices[event])
      )
        pending.delete(key);
    }
    emit();
  };
  return {
    receive(rows: readonly AlertPolicyRow[]) {
      remote = rows;
      reconcile();
    },
    async write(row: AlertPolicyRow, save: () => Promise<null>): Promise<null> {
      const key = keyOf(row);
      const entry = { row, revision: ++revision, settled: false, failed: false };
      const previous = pending.get(key);
      pending.set(key, entry);
      emit();
      try {
        await save();
        entry.settled = true;
        reconcile();
        return null;
      } catch (error) {
        entry.failed = true;
        if (pending.get(key) === entry) {
          if (previous && !previous.failed) pending.set(key, previous);
          else pending.delete(key);
          reconcile();
        }
        throw error;
      }
    },
  };
}
