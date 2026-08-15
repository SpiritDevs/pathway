import type { ModelSelection, ServerConfig as T3ServerConfig } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Modal, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { useThemeColor } from "../../lib/useThemeColor";

export type MobileContinuationWorkspaceTarget = "current" | "new-worktree";

export function ThreadContinuationSheet(props: {
  readonly visible: boolean;
  readonly kind: "continue" | "handoff" | "recovery";
  readonly sourceModelSelection: ModelSelection;
  readonly serverConfig: T3ServerConfig | null;
  readonly canCreateWorktree: boolean;
  readonly pending: boolean;
  readonly onDismiss: () => void;
  readonly onSubmit: (
    modelSelection: ModelSelection,
    workspaceTarget: MobileContinuationWorkspaceTarget,
  ) => void;
}) {
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon-subtle");
  const accentColor = useThemeColor("--color-primary");
  const options = useMemo(() => {
    const all = buildModelOptions(props.serverConfig, props.sourceModelSelection);
    return props.kind === "handoff"
      ? all.filter(
          (option) => option.selection.instanceId !== props.sourceModelSelection.instanceId,
        )
      : props.kind === "recovery"
        ? all.filter(
            (option) =>
              option.selection.instanceId !== props.sourceModelSelection.instanceId ||
              option.selection.model !== props.sourceModelSelection.model,
          )
        : all;
  }, [props.kind, props.serverConfig, props.sourceModelSelection]);
  const groups = useMemo(() => groupByProvider(options), [options]);
  const [selection, setSelection] = useState(props.sourceModelSelection);
  useEffect(() => {
    if (!props.visible) return;
    setSelection(
      props.kind === "handoff" || props.kind === "recovery"
        ? (options[0]?.selection ?? props.sourceModelSelection)
        : props.sourceModelSelection,
    );
  }, [options, props.kind, props.sourceModelSelection, props.visible]);

  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="slide"
      onRequestClose={props.pending ? undefined : props.onDismiss}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close continuation menu"
        disabled={props.pending}
        onPress={props.onDismiss}
        className="flex-1 justify-end bg-black/35"
      >
        <Pressable
          accessibilityRole="none"
          onPress={(event) => event.stopPropagation()}
          className="max-h-[86%] rounded-t-[28px] bg-sheet px-5 pt-3"
          style={{ paddingBottom: Math.max(insets.bottom, 16) }}
        >
          <View className="mb-4 items-center">
            <View className="mb-4 h-1 w-10 rounded-full bg-neutral-300 dark:bg-neutral-700" />
            <Text className="text-xl font-t3-bold text-foreground">
              {props.kind === "handoff"
                ? "Hand off this chat"
                : props.kind === "recovery"
                  ? "Recover with another model"
                  : "Continue in a new chat"}
            </Text>
            <Text className="mt-1 text-center text-sm text-foreground-muted">
              {props.kind === "handoff"
                ? "Choose another provider or account for the next response."
                : props.kind === "recovery"
                  ? "Choose a different model to continue the interrupted work in this chat."
                  : "Choose the model and checkout that continues this response."}
            </Text>
          </View>
          <ScrollView className="mb-4" showsVerticalScrollIndicator={false}>
            {groups.map((group) => (
              <View key={group.providerKey} className="mb-4">
                <Text className="mb-1 px-2 text-xs font-t3-bold uppercase text-foreground-muted">
                  {group.providerLabel}
                </Text>
                <View className="overflow-hidden rounded-2xl bg-neutral-100 dark:bg-white/[0.06]">
                  {group.models.map((option) => {
                    const selected =
                      selection.instanceId === option.selection.instanceId &&
                      selection.model === option.selection.model;
                    return (
                      <Pressable
                        key={option.key}
                        accessibilityRole="radio"
                        accessibilityState={{ selected }}
                        disabled={props.pending}
                        onPress={() => setSelection(option.selection)}
                        className="min-h-12 flex-row items-center px-3 py-2.5"
                      >
                        <Text className="min-w-0 flex-1 text-base font-t3-medium text-foreground">
                          {option.label}
                        </Text>
                        {selected ? (
                          <SymbolView
                            name="checkmark.circle.fill"
                            size={20}
                            tintColor={accentColor}
                            type="monochrome"
                          />
                        ) : null}
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            ))}
          </ScrollView>
          {(props.kind === "handoff" || props.kind === "recovery") && options.length === 0 ? (
            <Text className="pb-3 text-center text-sm text-foreground-muted">
              No other model is ready.
            </Text>
          ) : null}
          <View className="gap-2">
            <ContinuationChoice
              title={
                props.kind === "handoff"
                  ? "Hand off"
                  : props.kind === "recovery"
                    ? "Switch and continue"
                    : "Use this worktree"
              }
              description={
                props.kind === "handoff"
                  ? "Use this provider for the next response"
                  : props.kind === "recovery"
                    ? "Resume the interrupted work in this chat"
                    : "Continue in the current checkout"
              }
              disabled={
                props.pending ||
                ((props.kind === "handoff" || props.kind === "recovery") && options.length === 0)
              }
              pending={props.pending}
              iconColor={iconColor}
              onPress={() => props.onSubmit(selection, "current")}
            />
            {props.kind === "continue" && props.canCreateWorktree ? (
              <ContinuationChoice
                title="Use a new worktree"
                description="Start from the source checkout's committed HEAD"
                disabled={props.pending}
                pending={props.pending}
                iconColor={iconColor}
                onPress={() => props.onSubmit(selection, "new-worktree")}
              />
            ) : null}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function ContinuationChoice(props: {
  readonly title: string;
  readonly description: string;
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly iconColor: import("react-native").ColorValue;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-14 flex-row items-center gap-3 rounded-2xl bg-neutral-100 px-4 py-3 disabled:opacity-50 dark:bg-white/[0.06]"
    >
      {props.pending ? (
        <ActivityIndicator size="small" color={props.iconColor} />
      ) : (
        <SymbolView name="arrow.triangle.branch" size={19} tintColor={props.iconColor} />
      )}
      <View className="min-w-0 flex-1">
        <Text className="text-base font-t3-bold text-foreground">{props.title}</Text>
        <Text className="text-sm text-foreground-muted">{props.description}</Text>
      </View>
    </Pressable>
  );
}
