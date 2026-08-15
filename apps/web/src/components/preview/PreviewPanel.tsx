"use client";

import type { PreviewAnnotationPayload, ScopedThreadRef } from "@spiritdevs/contracts";
import type { ReactNode } from "react";

import type { ComposerImageAttachment } from "~/composerDraftStore";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";

import { PreviewPanelShell, type PreviewPanelMode } from "./PreviewPanelShell";
import { PreviewView } from "./PreviewView";

interface Props {
  mode: PreviewPanelMode;
  threadRef: ScopedThreadRef;
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
  tabId,
  configuredUrls,
  visible,
  allowInlinePictureInPicture = true,
  footer,
  onSendAnnotation,
}: Props) {
  if (!isPreviewSupportedInRuntime()) {
    return (
      <PreviewPanelShell mode={mode}>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <p className="max-w-sm text-sm text-muted-foreground">
            Preview is only available in the Pathway desktop app.
          </p>
        </div>
      </PreviewPanelShell>
    );
  }

  return (
    <PreviewPanelShell mode={mode}>
      <PreviewView
        threadRef={threadRef}
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
