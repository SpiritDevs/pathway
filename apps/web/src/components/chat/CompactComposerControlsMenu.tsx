import { ProviderInteractionMode, RuntimeMode } from "@spiritdevs/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon, TargetIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  goalMode: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  disabledReason?: string;
  onComposerModeChange: (mode: "goal" | "plan" | "default") => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const trigger = (
    <MenuTrigger
      render={
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
          aria-label={
            props.disabledReason
              ? `More composer controls. ${props.disabledReason}`
              : "More composer controls"
          }
          disabled={Boolean(props.disabledReason)}
        />
      }
    >
      {props.goalMode ? (
        <>
          <TargetIcon aria-hidden="true" className="size-4" />
          <span>Goal</span>
        </>
      ) : (
        <EllipsisIcon aria-hidden="true" className="size-4" />
      )}
    </MenuTrigger>
  );

  return (
    <Menu open={props.disabledReason ? false : undefined}>
      {props.disabledReason ? (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" title={props.disabledReason} />}>
            {trigger}
          </TooltipTrigger>
          <TooltipPopup side="top">{props.disabledReason}</TooltipPopup>
        </Tooltip>
      ) : (
        trigger
      )}
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle || props.goalMode ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.goalMode ? "goal" : props.interactionMode}
              onValueChange={(value) => {
                if (props.disabledReason) return;
                if (value !== "default" && value !== "plan" && value !== "goal") return;
                props.onComposerModeChange(value);
              }}
            >
              <MenuRadioItem value="default" disabled={Boolean(props.disabledReason)}>
                Build
              </MenuRadioItem>
              <MenuRadioItem
                value="plan"
                disabled={Boolean(props.disabledReason) || !props.showInteractionModeToggle}
              >
                Plan
              </MenuRadioItem>
              <MenuRadioItem value="goal" disabled={Boolean(props.disabledReason)}>
                Goal
              </MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (props.disabledReason) return;
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          <MenuRadioItem value="approval-required" disabled={Boolean(props.disabledReason)}>
            Supervised
          </MenuRadioItem>
          <MenuRadioItem value="auto-accept-edits" disabled={Boolean(props.disabledReason)}>
            Auto-accept edits
          </MenuRadioItem>
          <MenuRadioItem value="auto" disabled={Boolean(props.disabledReason)}>
            Auto
          </MenuRadioItem>
          <MenuRadioItem value="full-access" disabled={Boolean(props.disabledReason)}>
            Full access
          </MenuRadioItem>
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
