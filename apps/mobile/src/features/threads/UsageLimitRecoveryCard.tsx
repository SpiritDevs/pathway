import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { Pressable, View } from "react-native";

function resetTimeLabel(resetAt: string | null): string {
  if (resetAt === null) return "Reset time unavailable";
  const date = new Date(resetAt);
  if (Number.isNaN(date.getTime())) return "Reset time unavailable";
  return `Wait until ${new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date)}`;
}

export function UsageLimitRecoveryCard(props: {
  readonly resetAt: string | null;
  readonly pending: boolean;
  readonly canWaitUntilReset: boolean;
  readonly onRecover: () => void;
  readonly onWaitUntilReset: () => void;
}) {
  return (
    <View className="mx-2 mb-2 gap-3 rounded-2xl border border-rose-500/20 bg-rose-500/[0.04] p-3.5">
      <View className="gap-1">
        <Text className="font-pathway-bold text-sm text-foreground">Usage limit reached</Text>
        <Text className="text-xs leading-5 text-foreground-muted">
          Continue this work with another model, or put the thread aside until the allowance resets.
        </Text>
      </View>
      <View className="flex-row flex-wrap gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try another model"
          disabled={props.pending}
          onPress={props.onRecover}
          className="min-h-10 flex-row items-center gap-2 rounded-xl bg-primary px-3 disabled:opacity-50"
        >
          <SymbolView name="arrow.left.arrow.right" size={13} tintColor="white" type="monochrome" />
          <Text className="font-pathway-bold text-xs text-white">Try another model</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={resetTimeLabel(props.resetAt)}
          disabled={props.pending || !props.canWaitUntilReset || props.resetAt === null}
          onPress={props.onWaitUntilReset}
          className="min-h-10 flex-row items-center gap-2 rounded-xl border border-neutral-300/70 px-3 disabled:opacity-50 dark:border-white/[0.12]"
        >
          <SymbolView name="alarm" size={13} type="monochrome" />
          <Text className="font-pathway-bold text-xs text-foreground">
            {props.pending ? "Working…" : resetTimeLabel(props.resetAt)}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
