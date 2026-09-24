import type { ComponentType, Dispatch, ReactElement, ReactNode, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@spiritdevs/contracts";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
  lastResource: null as unknown,
  sharedSources: null as
    | { environmentId: EnvironmentId; cwd: string; faviconPath: string }[]
    | null,
  libraryIcon: null as
    | { _tag: "Library"; icon: { name: string; color: string } }
    | { _tag: "Image"; url: string }
    | null,
  assetStatus: "Success" as "Success" | "Failure" | "Loading",
  sourcePath: undefined as string | undefined,
  refresh: vi.fn(),
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "library-icon" ? testState.libraryIcon : testState.sharedSources,
}));

vi.mock("../state/projectIcons", () => ({
  projectIconAtom: () => "library-icon",
  projectIconCheckoutKey: (environmentId: string, cwd: string) => `${environmentId}:${cwd}`,
}));

vi.mock("../state/projectFavicons", () => ({ projectFaviconCandidatesAtom: () => null }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.lastResource = resource;
    return {
      _tag: testState.assetStatus,
      url: testState.faviconUrl,
      refresh: testState.refresh,
      sourcePath: testState.sourcePath,
    };
  },
}));

import { ProjectFavicon, RootedProjectFavicon } from "./ProjectFavicon";

type ProjectFaviconImageProps = {
  readonly cacheKey: string;
  readonly src: string;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
  readonly fallback?: ReactNode;
  readonly refresh?: (() => void) | undefined;
};

type ImageElement = ReactElement<{
  readonly src: string;
  readonly onLoad?: () => void;
  readonly onError?: () => void;
}>;

type ProjectFaviconImageElement = ReactElement<{
  readonly children: [ReactElement | null, ImageElement | null, ImageElement | null];
}>;

function resolveImageComponent(): {
  readonly Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement;
  readonly props: ProjectFaviconImageProps;
} {
  hooks.beginRender();
  const element = RootedProjectFavicon({
    environmentId: "environment-test" as EnvironmentId,
    cwd: "/workspace-test",
  }) as ReactElement<ProjectFaviconImageProps>;
  hooks.reset();

  return {
    Component: element.type as (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
    props: element.props,
  };
}

function renderImage(
  Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
  props: ProjectFaviconImageProps,
): ProjectFaviconImageElement {
  hooks.beginRender();
  return Component(props);
}

describe("ProjectFavicon", () => {
  beforeEach(() => {
    testState.sharedSources = null;
    testState.libraryIcon = null;
    testState.assetStatus = "Success";
    testState.sourcePath = undefined;
    testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-20-favicon.svg";
    testState.refresh.mockReset();
    hooks.reset();
  });

  it("shows a company project's library icon instead of any detected favicon", () => {
    testState.lastResource = null;
    testState.libraryIcon = { _tag: "Library", icon: { name: "Rocket", color: "#ef4444" } };
    const element = ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace-test",
    }) as ReactElement<{ readonly iconName: string; readonly color: string }>;

    expect(element.props).toMatchObject({ iconName: "Rocket", color: "#ef4444" });
    expect(testState.lastResource).toBeNull();
  });

  it("shows a company project's uploaded image without asking any environment", () => {
    testState.lastResource = null;
    testState.libraryIcon = { _tag: "Image", url: "https://files.test/icon.png" };
    const element = ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace-test",
    }) as ReactElement<{ readonly src: string }>;

    expect(element.type).toBe("img");
    expect(element.props.src).toBe("https://files.test/icon.png");
    expect(testState.lastResource).toBeNull();
  });

  it("falls back when the displayed favicon fails without discarding a valid older image early", () => {
    const { Component, props } = resolveImageComponent();
    const initialLoadingImage = renderImage(Component, props).props.children[2];
    initialLoadingImage?.props.onLoad?.();

    const refreshedProps = {
      ...props,
      src: "https://environment.test/api/assets/token-b/v1-20-favicon.svg",
    };
    const refreshing = renderImage(Component, refreshedProps).props.children;
    expect(refreshing[1]?.props.src).toBe(props.src);
    refreshing[2]?.props.onError?.();

    const afterRefreshError = renderImage(Component, refreshedProps).props.children;
    expect(afterRefreshError[1]?.props.src).toBe(props.src);
    afterRefreshError[1]?.props.onError?.();

    const afterDisplayedError = renderImage(Component, refreshedProps).props.children;
    expect(afterDisplayedError[0]).not.toBeNull();
    expect(afterDisplayedError[1]).toBeNull();
  });

  it("requests a saved favicon path when one is set", () => {
    RootedProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: "/workspace-test",
      faviconPath: "brand/icon.svg",
    });

    expect(testState.lastResource).toEqual({
      _tag: "project-favicon",
      cwd: "/workspace-test",
      path: "brand/icon.svg",
    });
  });

  it("requests the shared project's icon from its own host and directory", () => {
    testState.sharedSources = [
      {
        environmentId: "other-host" as EnvironmentId,
        cwd: "/other/checkout",
        faviconPath: "brand/icon.svg",
      },
    ];
    const element = ProjectFavicon({
      environmentId: "thread-host" as EnvironmentId,
      cwd: "/thread/checkout",
    }) as ReactElement<Parameters<typeof RootedProjectFavicon>[0]>;
    const Shared = element.type as (
      props: typeof element.props,
    ) => ReactElement<typeof element.props>;
    const rooted = Shared(element.props);
    expect(rooted.props).toMatchObject(testState.sharedSources[0]!);
    RootedProjectFavicon(rooted.props);
    expect(testState.lastResource).toEqual({
      _tag: "project-favicon",
      cwd: "/other/checkout",
      path: "brand/icon.svg",
    });
  });

  it.each(["Failure", "missing", "automatic"] as const)(
    "tries another checkout when the first asset is %s",
    (failure) => {
      testState.sharedSources = [
        {
          environmentId: "preferred-host" as EnvironmentId,
          cwd: "/preferred",
          faviconPath: "brand/icon.png",
        },
        {
          environmentId: "other-host" as EnvironmentId,
          cwd: "/other",
          faviconPath: "brand/icon.png",
        },
      ];
      const element = ProjectFavicon({
        environmentId: "preferred-host" as EnvironmentId,
        cwd: "/preferred",
      }) as ReactElement<Parameters<typeof RootedProjectFavicon>[0]>;
      const Shared = element.type as (
        props: typeof element.props,
      ) => ReactElement<typeof element.props>;
      const first = Shared(element.props);
      if (failure === "Failure") testState.assetStatus = "Failure";
      else if (failure === "missing")
        testState.faviconUrl = "https://environment.test/api/assets/token/project-favicon-missing";
      else testState.sourcePath = "favicon.svg";
      const next = RootedProjectFavicon(first.props) as ReactElement<typeof element.props>;
      expect(next.type).toBe(RootedProjectFavicon);
      expect(next.props).toMatchObject(testState.sharedSources[1]!);
      testState.assetStatus = "Success";
      testState.sourcePath = "brand/icon.png";
      testState.faviconUrl = "https://environment.test/api/assets/token/v1-icon.png";
      RootedProjectFavicon(next.props);
      expect(testState.lastResource).toEqual({
        _tag: "project-favicon",
        cwd: "/other",
        path: "brand/icon.png",
      });
    },
  );

  it("tries the next checkout and refreshes the capability when an image fails to load", () => {
    testState.faviconUrl = "https://environment.test/api/assets/failed/v1-broken.png";
    const { Component, props } = resolveImageComponent();
    const fallback = <span>Next checkout</span>;
    const withFallback = { ...props, fallback };
    renderImage(Component, withFallback).props.children[2]?.props.onError?.();
    const failed = renderImage(Component, withFallback);
    expect(failed.props.children[0]).toBe(fallback);
    expect(failed.props.children[2]).toBeNull();
    expect(testState.refresh).toHaveBeenCalledOnce();
  });

  it("renders the fallback for a rootless project without asking for an asset", () => {
    testState.lastResource = null;
    const element = ProjectFavicon({
      environmentId: "environment-test" as EnvironmentId,
      cwd: null,
    }) as ReactElement<{ readonly icon: ComponentType<{ className?: string }> }>;

    // A rootless project has no directory to read a favicon out of, so nothing is requested and
    // the row still renders — visible everywhere is the rule.
    expect(testState.lastResource).toBeNull();
    expect(element.props.icon).toBeDefined();
  });
});
