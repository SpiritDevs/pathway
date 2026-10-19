import {
  ALERT_EVENT_KEYS,
  resolveAlertPolicy,
  type AlertPolicyOverride,
  type AlertPolicyRow,
} from "@spiritdevs/contracts/threadAlerts";

export const ALERT_EVENT_LABELS = {
  completion: "Completion",
  permission: "Permission requests",
  input: "User input",
  failure: "Failure",
} as const;
const policyIndexes = new WeakMap<
  readonly AlertPolicyRow[],
  ReadonlyMap<string, AlertPolicyOverride>
>();
const inheritedChoices: AlertPolicyOverride = {};

/** Index each shared snapshot once so rendering many bells does not repeatedly scan every policy. */
export function policyChoices(
  rows: readonly AlertPolicyRow[] | null,
  scopeKind: AlertPolicyRow["scopeKind"],
  scopeKey: string,
): AlertPolicyOverride {
  if (rows === null) return inheritedChoices;
  let index = policyIndexes.get(rows);
  if (!index) {
    index = new Map(rows.map((row) => [`${row.scopeKind}:${row.scopeKey}`, row.choices]));
    policyIndexes.set(rows, index);
  }
  return index.get(`${scopeKind}:${scopeKey}`) ?? inheritedChoices;
}
export function threadPolicyView(
  rows: readonly AlertPolicyRow[] | null,
  projectKey: string | null,
  threadKey: string,
) {
  const choices = policyChoices(rows, "thread", threadKey);
  const inherited = resolveAlertPolicy(
    policyChoices(rows, "global", "global"),
    projectKey === null ? null : policyChoices(rows, "project", projectKey),
  );
  const effective = resolveAlertPolicy(inherited, null, choices);
  const count = ALERT_EVENT_KEYS.filter((key) => effective[key]).length;
  return {
    choices,
    inherited,
    effective,
    state: count === 4 ? "on" : count === 0 ? "off" : "mixed",
    explicit: ALERT_EVENT_KEYS.some((key) => choices[key] !== undefined),
  } as const;
}
export function bulkAlertChoices(effective: AlertPolicyOverride) {
  const enabled = !ALERT_EVENT_KEYS.every((key) => effective[key]);
  return { completion: enabled, permission: enabled, input: enabled, failure: enabled };
}
