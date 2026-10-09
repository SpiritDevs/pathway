import {
  type ClientSettings,
  resolveBrowserAgentAccess,
  setBrowserAgentSitePolicy,
} from "@spiritdevs/contracts";

import { getClientSettings, persistClientSettingsPatch } from "~/hooks/useSettings";

/**
 * Agent access to the desktop's built-in browser, from Settings → Browser.
 * Sites set to Requires approval, and history set to Always ask, prompt the
 * user; the prompt renders in {@link BrowserAgentApprovalHost}.
 */

export type BrowserAgentApprovalRequest =
  | { readonly kind: "site"; readonly origin: string }
  | { readonly kind: "history" };

/** Session approvals last until Pathway restarts; Always allow saves the setting. */
export type BrowserAgentApprovalChoice = "session" | "always" | "deny";

export interface PendingBrowserAgentApproval {
  readonly key: string;
  readonly request: BrowserAgentApprovalRequest;
}

/** The page's origin when it is a website agents need permission for, else null. */
export function browserAgentOrigin(url: string | null | undefined): string | null {
  if (!url || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
}

/** What the user's settings say about an agent browsing this page. */
export function browserAgentSiteDecision(
  settings: Pick<ClientSettings, "browserAgentPermissions">,
  url: string | null | undefined,
): "allow" | "ask" | "block" {
  const origin = browserAgentOrigin(url);
  if (origin === null) return "allow";
  const { browse } = resolveBrowserAgentAccess(settings.browserAgentPermissions, origin);
  return browse === "approval" ? "ask" : browse;
}

const approvalKey = (request: BrowserAgentApprovalRequest) =>
  request.kind === "site" ? `site:${request.origin}` : "history";

const sessionGrants = new Set<string>();
const waiters = new Map<string, Array<(allowed: boolean) => void>>();
let pending: ReadonlyArray<PendingBrowserAgentApproval> = [];
const listeners = new Set<() => void>();

const publish = (next: ReadonlyArray<PendingBrowserAgentApproval>) => {
  pending = next;
  for (const listener of listeners) listener();
};

export function subscribeBrowserAgentApprovals(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function readBrowserAgentApprovals(): ReadonlyArray<PendingBrowserAgentApproval> {
  return pending;
}

/**
 * Asks the user, resolving true once they allow. Resolves "pending" when they
 * have not answered within `waitMs`; the prompt stays up, and a session or
 * always approval lets the agent's retry through.
 */
export function requestBrowserAgentApproval(
  request: BrowserAgentApprovalRequest,
  waitMs: number,
): Promise<boolean | "pending"> {
  const key = approvalKey(request);
  if (sessionGrants.has(key)) return Promise.resolve(true);
  if (!waiters.has(key)) {
    waiters.set(key, []);
    publish([...pending, { key, request }]);
  }
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      const list = waiters.get(key);
      if (list)
        waiters.set(
          key,
          list.filter((waiter) => waiter !== settle),
        );
      resolve("pending");
    }, waitMs);
    const settle = (allowed: boolean) => {
      window.clearTimeout(timer);
      resolve(allowed);
    };
    waiters.get(key)!.push(settle);
  });
}

export async function answerBrowserAgentApproval(
  key: string,
  choice: BrowserAgentApprovalChoice,
): Promise<void> {
  const entry = pending.find((candidate) => candidate.key === key);
  if (!entry) return;
  const allowed = choice !== "deny";
  if (allowed) sessionGrants.add(key);
  const settled = waiters.get(key) ?? [];
  waiters.delete(key);
  publish(pending.filter((candidate) => candidate.key !== key));
  for (const settle of settled) settle(allowed);
  if (choice !== "always") return;
  const { request } = entry;
  if (request.kind === "history") {
    await persistClientSettingsPatch({ browserHistoryAccess: "allow" });
    return;
  }
  const permissions = getClientSettings().browserAgentPermissions;
  const existing = permissions.sites.find((site) => site.pattern === request.origin);
  const { pattern: _pattern, ...access } = existing ?? { pattern: request.origin };
  await persistClientSettingsPatch({
    browserAgentPermissions: setBrowserAgentSitePolicy(permissions, request.origin, {
      ...access,
      browse: "allow",
    }),
  });
}

export function resetBrowserAgentApprovalsForTests(): void {
  sessionGrants.clear();
  waiters.clear();
  publish([]);
}
