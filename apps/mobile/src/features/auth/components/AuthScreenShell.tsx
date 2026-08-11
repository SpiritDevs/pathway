import type { ReactNode } from "react";
import { Platform, Pressable, ScrollView, StatusBar, View, useColorScheme } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { BrandMark } from "../../../components/BrandMark";
import { useThemeColor } from "../../../lib/useThemeColor";

/**
 * Chrome shared by every signed-out surface and by the onboarding stepper.
 *
 * These screens live outside the root navigator (the gate swaps the whole tree
 * before navigation mounts), so they carry their own status bar, safe-area
 * insets, and back affordance instead of inheriting a native stack header.
 */
export function AuthScreenShell(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly onBack?: () => void;
  readonly showBrand?: boolean;
  readonly progressLabel?: string;
  readonly headerAccessory?: ReactNode;
}) {
  const colorScheme = useColorScheme();
  const screenBg = useThemeColor("--color-screen");
  const iconColor = useThemeColor("--color-foreground");
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <StatusBar
        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={screenBg as string}
        translucent
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        className="flex-1"
      >
        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            flexGrow: 1,
            gap: 20,
            paddingBottom: Math.max(insets.bottom, 20) + 20,
            paddingHorizontal: 20,
            paddingTop: 12,
          }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          <View collapsable={false} className="min-h-11 flex-row items-center justify-between">
            {props.onBack ? (
              <Pressable
                accessibilityLabel="Back"
                accessibilityRole="button"
                className="size-11 items-center justify-center rounded-full bg-subtle active:opacity-70"
                hitSlop={8}
                onPress={props.onBack}
              >
                <SymbolView name="chevron.left" size={18} tintColor={iconColor} type="monochrome" />
              </Pressable>
            ) : (
              <View className="size-11" />
            )}
            {props.progressLabel ? (
              <Text className="text-2xs font-t3-bold tracking-[1px] uppercase text-foreground-muted">
                {props.progressLabel}
              </Text>
            ) : null}
            {props.headerAccessory ?? <View className="size-11" />}
          </View>

          {props.showBrand ? (
            <View collapsable={false} className="items-center">
              <BrandMark />
            </View>
          ) : null}

          <View collapsable={false} className="gap-2">
            <Text className="text-3xl font-t3-bold tracking-[-0.6px] text-foreground">
              {props.title}
            </Text>
            {props.subtitle ? (
              <Text className="text-base leading-normal text-foreground-muted">
                {props.subtitle}
              </Text>
            ) : null}
          </View>

          {props.children}

          {props.footer ? (
            <View collapsable={false} className="mt-auto pt-4">
              {props.footer}
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
