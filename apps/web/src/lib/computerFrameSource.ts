import { COMPUTER_FRAME_RESYNC_MESSAGE } from "@spiritdevs/contracts";
import { decodeComputerFrame, type ComputerFrame } from "@spiritdevs/shared/computerFrame";

import {
  createBinaryFrameSource,
  type FrameSourceClose,
  type FrameSourceResetReason,
  type WebSocketLike,
} from "./binaryFrameSource";

export interface ComputerFrameSourceHandlers {
  readonly onFrame: (frame: ComputerFrame) => void;
  readonly onReset: (reason: ComputerFrameSourceResetReason, close?: FrameSourceClose) => void;
}

export type ComputerFrameSourceResetReason = FrameSourceResetReason;
export type ComputerFrameSourceClose = FrameSourceClose;

export const COMPUTER_FRAME_RESYNC_COOLDOWN_MS = 1_000;

export interface ComputerFrameSource {
  readonly requestResync: () => boolean;
  readonly close: () => void;
}

export interface ComputerFrameSourceOptions {
  /**
   * Resolved by `resolveComputerFrameSocketUrl` for the environment's prepared
   * connection. Remote URLs carry a short-lived ticket; the stream reuses
   * one URL across reconnects until its ticket nears expiry.
   */
  readonly url: string;
  readonly handlers: ComputerFrameSourceHandlers;
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly now?: () => number;
  readonly resyncCooldownMs?: number;
}

export type { WebSocketLike };

export function createComputerFrameSource(
  options: ComputerFrameSourceOptions,
): ComputerFrameSource {
  return createBinaryFrameSource({
    url: options.url,
    resyncMessage: COMPUTER_FRAME_RESYNC_MESSAGE,
    handlers: options.handlers,
    decode: decodeComputerFrame,
    ...(options.createSocket !== undefined ? { createSocket: options.createSocket } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    resyncCooldownMs: options.resyncCooldownMs ?? COMPUTER_FRAME_RESYNC_COOLDOWN_MS,
  });
}
