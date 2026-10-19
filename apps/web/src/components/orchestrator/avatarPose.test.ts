import { describe, expect, it } from "vite-plus/test";
import {
  AVATAR_EYES,
  AVATAR_EXPRESSIONS,
  AVATAR_SHAPES,
  DEFAULT_AVATAR,
  DEFAULT_PERSONALITY,
} from "@spiritdevs/contracts/orchestratorAvatar";
import { avatarPose, avatarPath, mixAvatarPose } from "./avatarPose";

describe("avatar morph geometry", () => {
  it("keeps every shape and expression compatible, including intermediate eye outlines", () => {
    const resting = avatarPose(DEFAULT_AVATAR, "neutral", DEFAULT_PERSONALITY);
    for (const shape of AVATAR_SHAPES) {
      for (const eyes of AVATAR_EYES) {
        for (const mood of AVATAR_EXPRESSIONS) {
          const target = avatarPose({ shape, eyes }, mood, DEFAULT_PERSONALITY);
          for (const key of ["body", "left", "right", "pose"] as const) {
            expect(target[key]).toHaveLength(resting[key].length);
          }
          const midway = mixAvatarPose(resting, target, 0.5);
          for (const path of [midway.body, midway.left, midway.right]) {
            expect(path.every(Number.isFinite)).toBe(true);
            expect(path.slice(-2)).toEqual(path.slice(0, 2));
            expect(avatarPath(path)).not.toMatch(/NaN|undefined/);
          }
        }
      }
    }
  });
});
