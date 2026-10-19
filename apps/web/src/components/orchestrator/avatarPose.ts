import type {
  AvatarExpression,
  OrchestratorAvatarConfig,
  PersonalityTraits,
} from "@spiritdevs/contracts/orchestratorAvatar";

// Every silhouette and eye uses the same cubic topology, so a face can change
// expression without swapping elements or crossfading two sets of eyes.
function outline(points: readonly (readonly [number, number])[]) {
  const first = points[0]!;
  const coordinates = [...first];
  for (let i = 0; i < points.length; i++) {
    const previous = points[(i + points.length - 1) % points.length]!;
    const start = points[i]!;
    const end = points[(i + 1) % points.length]!;
    const next = points[(i + 2) % points.length]!;
    coordinates.push(
      start[0] + (end[0] - previous[0]) / 6,
      start[1] + (end[1] - previous[1]) / 6,
      end[0] - (next[0] - start[0]) / 6,
      end[1] - (next[1] - start[1]) / 6,
      ...end,
    );
  }
  return coordinates;
}

function silhouette(shape: OrchestratorAvatarConfig["shape"]) {
  return outline(
    Array.from({ length: 32 }, (_, i): [number, number] => {
      const angle = (i / 32) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle);
      const y = Math.sin(angle);
      switch (shape) {
        case "squircle": {
          const r = 41 / Math.pow(x ** 4 + y ** 4, 0.25);
          return [50 + r * x, 50 + r * y];
        }
        case "pebble": {
          const r = 40 + 2 * Math.sin(3 * angle + 1);
          return [50 + r * x, 50 + r * y];
        }
        case "cloud": {
          const r = 36 + 5 * Math.cos(5 * angle + 0.5);
          return [50 + r * x, 50 + r * y];
        }
        case "flower": {
          const r = 34 + 8 * Math.cos(6 * angle);
          return [50 + r * x, 50 + r * y];
        }
        case "drop":
          return [50 + 40 * x * (0.72 + 0.28 * y), 50 + 43 * y];
        default:
          return [50 + 42 * x, 50 + 42 * y];
      }
    }),
  );
}

const SILHOUETTES = Object.fromEntries(
  (["round", "pebble", "squircle", "cloud", "drop", "flower"] as const).map((shape) => [
    shape,
    silhouette(shape),
  ]),
);

function eye(width: number, height: number, smile: boolean, rotation: number, x: number) {
  const w = width / 2;
  const h = height / 2;
  const coordinates = smile
    ? [
        -w,
        1,
        -w,
        -2,
        -w * 0.55,
        -h,
        0,
        -h,
        w * 0.55,
        -h,
        w,
        -2,
        w,
        1,
        w,
        6,
        w * 0.5,
        -h + 6,
        0,
        -h + 6,
        -w * 0.5,
        -h + 6,
        -w,
        6,
        -w,
        1,
      ]
    : [
        -w,
        0,
        -w,
        -h * 0.8,
        -w * 0.8,
        -h,
        0,
        -h,
        w * 0.8,
        -h,
        w,
        -h * 0.8,
        w,
        0,
        w,
        h * 0.8,
        w * 0.8,
        h,
        0,
        h,
        -w * 0.8,
        h,
        -w,
        h * 0.8,
        -w,
        0,
      ];
  const angle = (rotation * Math.PI) / 180;
  return coordinates.map((value, i) =>
    i % 2 === 0
      ? x + value * Math.cos(angle) - coordinates[i + 1]! * Math.sin(angle)
      : 48 + coordinates[i - 1]! * Math.sin(angle) + value * Math.cos(angle),
  );
}

export function avatarPose(
  appearance: OrchestratorAvatarConfig,
  mood: AvatarExpression,
  traits: PersonalityTraits,
) {
  const strength = 0.35 + traits.expressiveness / 130;
  const smile = mood === "pleased" || mood === "encouraging";
  const width = smile
    ? 14 + traits.warmth / 30
    : appearance.eyes === "wide"
      ? 13
      : appearance.eyes === "round"
        ? 12
        : 10;
  const height = smile
    ? 17
    : appearance.eyes === "soft"
      ? 14
      : appearance.eyes === "round"
        ? 12
        : 23;
  return {
    body: SILHOUETTES[appearance.shape] ?? SILHOUETTES.round!,
    left: eye(
      width,
      height * (mood === "thoughtful" ? 0.65 : 1),
      smile,
      mood === "concerned" ? -18 : 0,
      37,
    ),
    right: eye(
      width,
      height * (mood === "curious" ? 1 + 0.25 * strength : mood === "thoughtful" ? 0.8 : 1),
      smile,
      mood === "concerned" ? 18 : 0,
      63,
    ),
    // The entire character leans into the expression; gaze moves independently.
    pose: [
      mood === "curious"
        ? -6 * strength
        : mood === "concerned"
          ? 5 * strength
          : mood === "encouraging"
            ? 3 * strength
            : 0,
      smile ? 1 + 0.035 * strength : mood === "thoughtful" ? 0.97 : 1,
      smile ? 1 - 0.025 * strength : mood === "curious" ? 1.035 : 1,
      mood === "curious" ? 3 + traits.curiosity / 25 : mood === "thoughtful" ? -4 : 0,
      mood === "thoughtful" ? -3 : smile ? -1 : 0,
    ],
  };
}

export type AvatarPose = ReturnType<typeof avatarPose>;

export function mixAvatarPose(from: AvatarPose, to: AvatarPose, progress: number): AvatarPose {
  const mix = (a: readonly number[], b: readonly number[]) =>
    a.map((value, i) => value + (b[i]! - value) * progress);
  return {
    body: mix(from.body, to.body),
    left: mix(from.left, to.left),
    right: mix(from.right, to.right),
    pose: mix(from.pose, to.pose),
  };
}

export function avatarPath(coordinates: readonly number[]) {
  return `M${coordinates.slice(0, 2).join(" ")}C${coordinates.slice(2).join(" ")}Z`;
}

export function avatarPoseTransform(pose: AvatarPose) {
  return `translate(50 50) rotate(${pose.pose[0]}) scale(${pose.pose[1]} ${pose.pose[2]}) translate(-50 -50)`;
}

export function avatarGazeTransform(pose: AvatarPose) {
  return `translate(${pose.pose[3]} ${pose.pose[4]})`;
}
