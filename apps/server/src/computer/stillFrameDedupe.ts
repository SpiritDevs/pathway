/**
 * `frameDigest` and `StillFrameDedupe` live in `./stillFramePublisher.ts`, the
 * single ticker that owns them. This module re-exports them for callers that
 * only need the dedupe.
 *
 * @module computer/stillFrameDedupe
 */
export { frameDigest, StillFrameDedupe } from "./stillFramePublisher.ts";
