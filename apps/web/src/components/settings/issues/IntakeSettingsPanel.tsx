/**
 * Settings → Issues → Triage & Intake.
 *
 * Two things: the bot token, and the channels it watches. The server polls
 * `conversations.history` per watched channel from a stored cursor — not Socket Mode and not a
 * webhook — so everything configured here is read by a loop that may have been asleep for a week,
 * and nothing on this page is live-connected to Slack except the channel picker, which asks.
 *
 * The token is write-only: it goes in and never comes back out, so the field is always empty and
 * the card reports the connection rather than the secret.
 *
 * @module components/settings/issues/IntakeSettingsPanel
 */
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import type {
  ProjectId,
  SlackChannelRef,
  SlackChannelWatch,
  SlackIntakeTrigger,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { FolderIcon, PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useProjects } from "~/state/entities";
import {
  useCreateSlackWatch,
  useDeleteSlackWatch,
  useIssuesStoreStatus,
  useSlackListChannels,
  useSlackSetToken,
  useSlackStatus,
  useSlackWatches,
  useUpdateSlackWatch,
} from "~/state/issues";
import { IssueSlackGlyph } from "../../issues/IssueGlyphs";
import { IssueProjectMenu } from "../../issues/IssuePropertyMenus";
import { reportIssueWriteFailure as reportFailure } from "../../issues/issueWriteFeedback";
import { QuickCreateProjectDialog } from "../../projects/QuickCreateProjectDialog";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import {
  normalizeSlackChannelName,
  normalizeSlackEmojiName,
  PAUSED_SLACK_TRIGGER,
  SLACK_BOT_TOKEN_SCOPES,
  slackChannelIdError,
  slackConnectionSummary,
  slackEmojiNameError,
  slackTriggerSummary,
  slackWatchLimitError,
  unwatchedSlackChannels,
} from "./slackIntake.logic";

function toast(type: "error" | "success", title: string, description?: string) {
  toastManager.add(
    stackedThreadToast({ type, title, ...(description === undefined ? {} : { description }) }),
  );
}

/**
 * One channel's triggers. All three off is a paused watch, which is why nothing here refuses to
 * turn the last one off: pausing a channel and forgetting how it was configured are different
 * things, and the row keeps saying what it would file if it were resumed.
 */
function TriggerControls({
  watch,
  busy,
  onTrigger,
}: {
  watch: SlackChannelWatch;
  busy: boolean;
  onTrigger: (trigger: SlackIntakeTrigger) => void;
}) {
  const { trigger } = watch;

  const commitEmoji = (raw: string) => {
    const next = normalizeSlackEmojiName(raw);
    if (next.length === 0) {
      if (trigger.emoji !== null) onTrigger({ ...trigger, emoji: null });
      return;
    }
    if (next === trigger.emoji) return;
    const error = slackEmojiNameError(next);
    if (error !== null) {
      toast("error", "Reaction trigger", error);
      return;
    }
    onTrigger({ ...trigger, emoji: next });
  };

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
        <span className="text-muted-foreground/70">:</span>
        <Input
          aria-label={`Reaction that files from #${watch.channelName}`}
          className="h-7 w-28"
          defaultValue={trigger.emoji ?? ""}
          disabled={busy}
          key={trigger.emoji ?? ""}
          onBlur={(event) => commitEmoji(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              event.currentTarget.value = trigger.emoji ?? "";
              event.currentTarget.blur();
            }
          }}
          placeholder="ticket"
          size="sm"
        />
        <span className="text-muted-foreground/70">:</span>
      </label>
      <label className="flex items-center gap-2 text-[13px] text-foreground">
        <Switch
          aria-label={`File every message in #${watch.channelName}`}
          checked={trigger.everyMessage}
          disabled={busy}
          onCheckedChange={(checked) => onTrigger({ ...trigger, everyMessage: checked === true })}
        />
        Every message
      </label>
      <label className="flex items-center gap-2 text-[13px] text-foreground">
        <Switch
          aria-label={`File bot mentions in #${watch.channelName}`}
          checked={trigger.botMention}
          disabled={busy}
          onCheckedChange={(checked) => onTrigger({ ...trigger, botMention: checked === true })}
        />
        Bot mention
      </label>
    </div>
  );
}

/**
 * The picker. It asks Slack when it opens rather than on render: `conversations.list` is a live
 * call that costs rate limit, and a settings page nobody is looking at should not spend it.
 *
 * The manual field is the fallback for exactly the case the picker cannot serve — no token, a
 * missing `channels:read`, or a channel the bot has not been invited to — so it appears when the
 * listing fails rather than sitting there suggesting people copy ids by hand.
 */
function AddChannelPopover({
  watches,
  disabled,
  onAdd,
}: {
  watches: ReadonlyArray<SlackChannelWatch>;
  disabled: boolean;
  onAdd: (channel: SlackChannelRef) => Promise<boolean>;
}) {
  const listChannels = useSlackListChannels();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [channels, setChannels] = useState<ReadonlyArray<SlackChannelRef>>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await listChannels({});
    setLoading(false);
    if (AsyncResult.isSuccess(result)) {
      setChannels(result.value.channels);
      setListError(null);
      return;
    }
    // Not a toast: the failure is the reason the manual field is showing, so it belongs next to it.
    setChannels([]);
    setListError(
      "Slack would not list the channels. Check the token and the channels:read scope, or add a channel by id.",
    );
  }, [listChannels]);

  const available = useMemo(() => unwatchedSlackChannels(channels, watches), [channels, watches]);

  const addManual = () => {
    const idError = slackChannelIdError(manualId);
    if (idError !== null) {
      toast("error", "Add channel", idError);
      return;
    }
    const name = normalizeSlackChannelName(manualName);
    void (async () => {
      const added = await onAdd({
        id: manualId.trim(),
        name: name.length === 0 ? manualId.trim() : name,
      });
      if (!added) return;
      setManualId("");
      setManualName("");
      setOpen(false);
    })();
  };

  return (
    <Popover
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void load();
      }}
      open={open}
    >
      <PopoverTrigger
        render={
          <Button disabled={disabled} size="sm" variant="outline">
            <PlusIcon className="size-3.5" />
            Add channel
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-80 p-2">
        <div className="flex items-center justify-between gap-2 pb-1.5">
          <span className="text-xs font-medium text-foreground">Channels the bot can see</span>
          <Button
            aria-label="Refresh the channel list"
            disabled={loading}
            onClick={() => void load()}
            size="icon-xs"
            variant="ghost"
          >
            <RefreshCwIcon
              className={cn("size-3", loading && "animate-spin motion-reduce:animate-none")}
            />
          </Button>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 px-1 py-3 text-[13px] text-muted-foreground">
            <Spinner className="size-3.5" />
            Asking Slack…
          </div>
        ) : listError === null ? (
          <div className="max-h-56 overflow-y-auto">
            {available.length === 0 ? (
              <p className="px-1 py-2 text-xs text-muted-foreground">
                Nothing left to watch. Invite the bot to a channel and refresh.
              </p>
            ) : (
              available.map((channel) => (
                <button
                  className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-start text-[13px] outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
                  key={channel.id}
                  onClick={() => {
                    void (async () => {
                      if (await onAdd(channel)) setOpen(false);
                    })();
                  }}
                  type="button"
                >
                  <IssueSlackGlyph className="size-3 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">#{channel.name}</span>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="space-y-1.5">
            <p className="px-1 text-[11px] text-muted-foreground">{listError}</p>
            <Input
              aria-label="Channel id"
              onChange={(event) => setManualId(event.currentTarget.value)}
              placeholder="C0123ABCD"
              size="sm"
              value={manualId}
            />
            <Input
              aria-label="Channel name"
              onChange={(event) => setManualName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addManual();
              }}
              placeholder="#design"
              size="sm"
              value={manualName}
            />
            <Button className="w-full" onClick={addManual} size="sm" variant="outline">
              Watch this channel
            </Button>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}

export function IntakeSettingsPanel() {
  const storeStatus = useIssuesStoreStatus();
  const status = useSlackStatus();
  const watches = useSlackWatches();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const setToken = useSlackSetToken();
  const createWatch = useCreateSlackWatch();
  const updateWatch = useUpdateSlackWatch();
  const deleteWatch = useDeleteSlackWatch();

  const [token, setToken_] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SlackChannelWatch | null>(null);
  /** Which row's project menu opened the quick-create, so the new project lands on that row. */
  const [quickCreateFor, setQuickCreateFor] = useState<SlackChannelWatch | null>(null);
  // Ticks so "Polled 3m ago" ages without a reload. A minute is as precise as the label gets.
  const nowMs = useRelativeTimeTick(30_000);

  const summary = slackConnectionSummary(status, nowMs);
  const limitError = slackWatchLimitError(watches);
  const projectTitles = useMemo(
    () => new Map<ProjectId, string>(projects.map((project) => [project.id, project.title])),
    [projects],
  );

  const run = useCallback(
    async (title: string, action: () => Promise<AtomCommandResult<unknown, unknown>>) => {
      setBusy(true);
      try {
        return !reportFailure(title, await action());
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const handleSaveToken = () => {
    const trimmed = token.trim();
    if (trimmed.length === 0) return;
    void (async () => {
      // The server tests the connection before it writes, so a refusal here means the token never
      // landed on disk — which is the whole point of testing first.
      const saved = await run("Failed to save the token", () => setToken({ token: trimmed }));
      if (!saved) return;
      setToken_("");
      toast("success", "Slack connected", "Polling starts on the next interval.");
    })();
  };

  const handleDisconnect = () => {
    void (async () => {
      const cleared = await run("Failed to disconnect", () => setToken({ token: "" }));
      if (cleared) toast("success", "Slack disconnected", "The watched channels are kept.");
    })();
  };

  const handleAddChannel = async (channel: SlackChannelRef): Promise<boolean> =>
    run("Failed to watch the channel", () =>
      createWatch({
        channelId: channel.id,
        channelName: normalizeSlackChannelName(channel.name),
        projectId: null,
        // Watched and filing nothing: a channel starts paused so nobody's backlog fills up
        // between adding it and deciding what should file from it.
        trigger: PAUSED_SLACK_TRIGGER,
      }),
    );

  if (storeStatus === "disconnected") {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-intake")}>
          <SettingsRow
            description="Intake runs on the machine you are connected to. Connect an environment to configure it."
            title="No environment connected"
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <>
      <QuickCreateProjectDialog
        environmentId={primaryEnvironmentId}
        onCreated={(created) => {
          const watch = quickCreateFor;
          if (watch === null) return;
          void run("Failed to map the channel", () =>
            updateWatch({ watchId: watch.id, patch: { projectId: created.projectId } }),
          );
        }}
        onOpenChange={(open) => {
          if (!open) setQuickCreateFor(null);
        }}
        open={quickCreateFor !== null}
      />

      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-intake")}>
          <SettingsRow
            description="A message in a watched channel becomes a triage item — no status, on no board, in no count. Accepting it gives it a status, a project, and a priority in one action and can start an investigation. The bot posts back into the source thread when somebody comments or moves it, and skips its own posts so the two sides cannot loop."
            title="How intake works"
          />

          <SettingsRow
            {...searchableSetting("slack-bot-token")}
            description="A bot token from your Slack app. It is written to this server's secrets directory and never sent back to a client — the field stays empty because there is nothing to show."
            status={
              <span
                className={cn(
                  "text-xs",
                  summary.tone === "error"
                    ? "text-destructive-foreground"
                    : summary.tone === "connected"
                      ? "text-muted-foreground"
                      : "text-muted-foreground/70",
                )}
              >
                {summary.headline}
                {summary.detail === null ? null : ` · ${summary.detail}`}
              </span>
            }
            control={
              <div className="flex w-full items-center gap-1.5 sm:w-72">
                <Input
                  aria-label="Slack bot token"
                  autoComplete="off"
                  className="min-w-0 flex-1"
                  disabled={busy}
                  onChange={(event) => setToken_(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleSaveToken();
                  }}
                  placeholder="xoxb-…"
                  size="sm"
                  type="password"
                  value={token}
                />
                <Button
                  disabled={busy || token.trim().length === 0}
                  onClick={handleSaveToken}
                  size="sm"
                >
                  {busy ? <Spinner className="size-3.5" /> : null}
                  Save
                </Button>
                {status.configured ? (
                  <Button disabled={busy} onClick={handleDisconnect} size="sm" variant="outline">
                    Disconnect
                  </Button>
                ) : null}
              </div>
            }
          />

          <SettingsRow
            description={`The app needs these bot scopes: ${SLACK_BOT_TOKEN_SCOPES.join(", ")}. Saving tests the connection, so a token short a scope is refused here rather than failing silently on the first poll.`}
            title="Scopes"
          />
        </SettingsSection>

        <SettingsSection
          {...searchableSetting("slack-watched-channels")}
          headerAction={
            <AddChannelPopover
              disabled={busy || limitError !== null}
              onAdd={handleAddChannel}
              watches={watches}
            />
          }
        >
          <SettingsRow
            description="Each channel is polled from its own cursor about every thirty seconds, so a server that was asleep catches up rather than missing what it slept through. A channel maps to a project, and everything filed from it lands there."
            title="Watched channels"
          />

          {limitError === null ? null : (
            <p className="px-3 text-[11px] text-muted-foreground sm:px-4">{limitError}</p>
          )}

          {watches.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-muted-foreground/80 sm:px-4">
              No channels watched yet. Invite the bot to a channel, then add it here.
            </p>
          ) : (
            watches.map((watch) => (
              <div
                className="flex flex-col gap-2 rounded-lg px-3 py-2.5 hover:bg-accent/30 sm:px-4"
                key={watch.id}
              >
                <div className="flex items-center gap-2">
                  <IssueSlackGlyph className="size-3.5 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                    #{watch.channelName}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {slackTriggerSummary(watch.trigger)}
                  </span>
                  <IssueProjectMenu
                    align="end"
                    onCreateProject={() => setQuickCreateFor(watch)}
                    onSelect={(projectId) =>
                      void run("Failed to map the channel", () =>
                        updateWatch({ watchId: watch.id, patch: { projectId } }),
                      )
                    }
                    projects={projects}
                    trigger={
                      <button
                        className="flex h-7 max-w-44 shrink-0 items-center gap-1.5 rounded-md border border-input px-2 text-xs text-foreground outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring"
                        type="button"
                      >
                        <FolderIcon className="size-3 text-muted-foreground" />
                        <span
                          className={cn(
                            "truncate",
                            watch.projectId === null && "text-muted-foreground",
                          )}
                        >
                          {watch.projectId === null
                            ? "No project"
                            : (projectTitles.get(watch.projectId) ?? "Unknown project")}
                        </span>
                      </button>
                    }
                    value={watch.projectId}
                  />
                  <Button
                    aria-label={`Stop watching #${watch.channelName}`}
                    className="text-muted-foreground hover:text-destructive-foreground"
                    disabled={busy}
                    onClick={() => setPendingDelete(watch)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                </div>
                <TriggerControls
                  busy={busy}
                  onTrigger={(trigger) =>
                    void run("Failed to change the triggers", () =>
                      updateWatch({ watchId: watch.id, patch: { trigger } }),
                    )
                  }
                  watch={watch}
                />
              </div>
            ))
          )}
        </SettingsSection>
      </SettingsPageContainer>

      <AlertDialog
        onOpenChange={(open) => {
          if (busy) return;
          if (!open) setPendingDelete(null);
        }}
        open={pendingDelete !== null}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop watching #{pendingDelete?.channelName}?</AlertDialogTitle>
            <AlertDialogDescription>
              Nothing new files from this channel. The issues it already filed keep their source,
              and the bot keeps replying in their threads. Turning every trigger off pauses the
              channel instead, which is usually what you want.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={busy} render={<Button disabled={busy} variant="outline" />}>
              Cancel
            </AlertDialogClose>
            <Button
              disabled={busy}
              onClick={() => {
                const watch = pendingDelete;
                if (watch === null) return;
                void (async () => {
                  const removed = await run("Failed to stop watching the channel", () =>
                    deleteWatch({ watchId: watch.id }),
                  );
                  if (removed) setPendingDelete(null);
                })();
              }}
              variant="destructive"
            >
              {busy ? <Spinner className="size-3.5" /> : null}
              Stop watching
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
