import { Image } from "expo-image";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { SymbolView } from "../../../components/AppSymbol";
import { AuthCard, AuthField } from "../components/AuthControls";
import { useThemeColor } from "../../../lib/useThemeColor";

/**
 * Step 1. The first name is the only hard-required field in the whole flow
 * (docs/internals/decisions/0004); the avatar and last name are optional.
 */
export function OnboardingIdentityStep(props: {
  readonly firstName: string;
  readonly lastName: string;
  readonly avatarUri: string | null;
  readonly isPickingAvatar: boolean;
  readonly onChangeFirstName: (value: string) => void;
  readonly onChangeLastName: (value: string) => void;
  readonly onPickAvatar: () => void;
}) {
  const iconColor = useThemeColor("--color-icon-muted");

  return (
    <AuthCard>
      <View collapsable={false} className="items-center gap-3 py-2">
        <Pressable
          accessibilityLabel="Choose a profile photo"
          accessibilityRole="button"
          accessibilityState={{ busy: props.isPickingAvatar }}
          className="size-24 items-center justify-center overflow-hidden rounded-full bg-subtle active:opacity-70"
          disabled={props.isPickingAvatar}
          onPress={props.onPickAvatar}
        >
          {props.avatarUri ? (
            <Image
              accessibilityIgnoresInvertColors
              source={{ uri: props.avatarUri }}
              style={{ height: 96, width: 96 }}
            />
          ) : (
            <SymbolView
              name="person.crop.circle"
              size={38}
              tintColor={iconColor}
              type="monochrome"
            />
          )}
        </Pressable>
        <Text className="text-xs text-foreground-muted">
          {props.isPickingAvatar ? "Uploading photo..." : "Add a photo (optional)"}
        </Text>
      </View>

      <AuthField
        label="First name"
        inputProps={{
          autoCapitalize: "words",
          autoComplete: "given-name",
          onChangeText: props.onChangeFirstName,
          placeholder: "Ada",
          textContentType: "givenName",
          value: props.firstName,
        }}
      />
      <AuthField
        label="Last name"
        hint="Optional."
        inputProps={{
          autoCapitalize: "words",
          autoComplete: "family-name",
          onChangeText: props.onChangeLastName,
          placeholder: "Lovelace",
          textContentType: "familyName",
          value: props.lastName,
        }}
      />
    </AuthCard>
  );
}
