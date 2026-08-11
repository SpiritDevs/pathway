import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../../components/AppText";
import type { AppTextInputProps } from "../../../components/AppText";
import { cn } from "../../../lib/cn";

/** Full-width primary/secondary action. Mirrors ConnectionSheetButton's tones. */
export function AuthButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly tone?: "primary" | "secondary";
  readonly disabled?: boolean;
  readonly busy?: boolean;
}) {
  const tone = props.tone ?? "primary";
  const disabled = props.disabled === true || props.busy === true;

  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy ?? false, disabled }}
      className={cn(
        "min-h-13 flex-row items-center justify-center gap-2 rounded-2xl px-4 py-3.5",
        "disabled:opacity-50",
        tone === "primary" ? "bg-primary" : "border border-border bg-secondary",
      )}
      disabled={disabled}
      onPress={props.onPress}
    >
      {props.busy ? <ActivityIndicator size="small" /> : null}
      <Text
        className={cn(
          "text-base font-t3-bold",
          tone === "primary" ? "text-primary-foreground" : "text-secondary-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

/** Low-emphasis inline action: "Create one", "Skip for now", "Resend code". */
export function AuthLinkButton(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly align?: "center" | "start";
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled ?? false }}
      className={cn(
        "min-h-11 justify-center py-1 active:opacity-70",
        props.disabled === true && "opacity-45",
        props.align === "start" ? "items-start" : "items-center",
      )}
      disabled={props.disabled}
      hitSlop={8}
      onPress={props.onPress}
    >
      <Text className="text-sm font-t3-medium text-foreground-secondary">{props.label}</Text>
    </Pressable>
  );
}

export function AuthField(props: {
  readonly label: string;
  readonly hint?: string;
  readonly inputProps: AppTextInputProps;
}) {
  return (
    <View collapsable={false} className="gap-1.5">
      <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
        {props.label}
      </Text>
      <TextInput accessibilityLabel={props.label} {...props.inputProps} />
      {props.hint ? <Text className="text-xs text-foreground-muted">{props.hint}</Text> : null}
    </View>
  );
}

/** Card that groups the fields of one step. */
export function AuthCard(props: { readonly children: ReactNode }) {
  return (
    <View collapsable={false} className="gap-4 rounded-[24px] bg-card p-4">
      {props.children}
    </View>
  );
}

export function AuthChip(props: {
  readonly label: string;
  readonly selected: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected }}
      className={cn(
        "min-h-11 justify-center rounded-full border px-4 py-2.5 active:opacity-70",
        props.selected ? "border-primary bg-primary" : "border-border bg-subtle",
      )}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "text-sm font-t3-medium",
          props.selected ? "text-primary-foreground" : "text-foreground",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function AuthChipGroup(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View collapsable={false} className="gap-2.5">
      <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
        {props.label}
      </Text>
      <View collapsable={false} className="flex-row flex-wrap gap-2">
        {props.children}
      </View>
    </View>
  );
}
