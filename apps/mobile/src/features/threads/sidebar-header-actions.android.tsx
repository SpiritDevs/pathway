import { View } from "react-native";

import { PathwayHeaderButton } from "../../native/PathwayHeaderButton.android";
import type { SidebarHeaderActionsProps } from "./sidebar-header-actions";

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="h-11 flex-row gap-1">
      <PathwayHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
