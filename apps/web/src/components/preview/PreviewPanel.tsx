"use client";

import type { PreviewAnnotationPayload, ScopedThreadRef } from "@spiritdevs/contracts";
import type { ReactNode } from "react";

import type { BrowserPlacement } from "~/browser/browserPlacement";
import type { ComposerImageAttachment } from "~/composerDraftStore";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
  placement: BrowserPlacement;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  allowInlinePictureInPicture?: boolean;
  /** Content docked below the browser viewport while this Preview surface is visible. */
  footer?: ReactNode;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

export function PreviewPanel({
  mode,
  threadRef,
  placement,
  tabId,
  configuredUrls,
  visible,
  allowInlinePictureInPicture = true,
  footer,
  onSendAnnotation,
}: Props) {
  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView
        threadRef={threadRef}
        placement={placement}
        {...(tabId !== undefined ? { tabId } : {})}
        configuredUrls={configuredUrls}
        visible={visible}
        allowInlinePictureInPicture={allowInlinePictureInPicture}
        {...(onSendAnnotation ? { onSendAnnotation } : {})}
      />
      {footer ? (
        <div className="shrink-0" data-preview-panel-footer>
          {footer}
        </div>
      ) : null}
    </PreviewPanelShell>
  );
}
