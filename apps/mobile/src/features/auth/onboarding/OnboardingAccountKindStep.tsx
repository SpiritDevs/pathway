import type { AccountKind } from "@t3tools/client-runtime/profile";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../../components/AppSymbol";
import { cn } from "../../../lib/cn";
import { useThemeColor } from "../../../lib/useThemeColor";

interface AccountKindOption {
  readonly value: AccountKind;
  readonly icon: AppSymbolName;
  readonly title: string;
  readonly description: string;
}

const ACCOUNT_KIND_OPTIONS: ReadonlyArray<AccountKindOption> = [
  {
    value: "individual",
    icon: "person.crop.circle",
    title: "Just me",
    description: "A personal workspace for your own machines.",
  },
  {
    value: "company",
    icon: "server.rack",
    title: "My company",
    description: "You build alongside a team.",
  },
];

/**
 * Step 2. Web renders these as half-width cards on a twelve-column grid;
 * React Native has no CSS grid, so they stack full-width — the flex
 * equivalent called out in docs/internals/decisions/0004. The choice is
 * written the moment it is made: resumption depends on write-as-you-go.
 */
export function OnboardingAccountKindStep(props: {
  readonly selected: AccountKind | null;
  readonly disabled: boolean;
  readonly onSelect: (value: AccountKind) => void;
}) {
  const iconColor = useThemeColor("--color-icon");
  const selectedIconColor = useThemeColor("--color-primary-foreground");

  return (
    <View collapsable={false} className="gap-3">
      {ACCOUNT_KIND_OPTIONS.map((option) => {
        const isSelected = props.selected === option.value;
        return (
          <Pressable
            accessibilityLabel={option.title}
            accessibilityRole="button"
            accessibilityState={{ disabled: props.disabled, selected: isSelected }}
            className={cn(
              "flex-row items-center gap-4 rounded-[24px] border p-5 active:opacity-70",
              isSelected ? "border-primary bg-primary" : "border-border bg-card",
              props.disabled && "opacity-60",
            )}
            disabled={props.disabled}
            key={option.value}
            onPress={() => props.onSelect(option.value)}
          >
            <View
              collapsable={false}
              className={cn(
                "size-12 items-center justify-center rounded-full",
                isSelected ? "bg-primary-foreground/20" : "bg-subtle",
              )}
            >
              <SymbolView
                name={option.icon}
                size={22}
                tintColor={isSelected ? selectedIconColor : iconColor}
                type="monochrome"
              />
            </View>
            <View collapsable={false} className="flex-1 gap-1">
              <Text
                className={cn(
                  "text-lg font-t3-bold",
                  isSelected ? "text-primary-foreground" : "text-foreground",
                )}
              >
                {option.title}
              </Text>
              <Text
                className={cn(
                  "text-sm leading-normal",
                  isSelected ? "text-primary-foreground" : "text-foreground-muted",
                )}
              >
                {option.description}
              </Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
