export interface ReferenceRepo {
  readonly id: string;
  readonly prefix: string;
  readonly repository: string;
  readonly latestRef: string;
  /** Pins the subtree to the installed package version. Repos without one always follow `latestRef`. */
  readonly version?: ReferenceRepoVersion;
}

export interface ReferenceRepoVersion {
  readonly sourcePath: string;
  readonly packagePath: ReadonlyArray<string>;
  readonly tagPrefix: string;
}

export const referenceRepos: ReadonlyArray<ReferenceRepo> = [
  {
    id: "effect-smol",
    prefix: ".repos/effect-smol",
    repository: "https://github.com/Effect-TS/effect.git",
    latestRef: "main",
    version: {
      sourcePath: "pnpm-workspace.yaml",
      packagePath: ["catalog", "effect"],
      tagPrefix: "effect@",
    },
  },
  {
    id: "alchemy-effect",
    prefix: ".repos/alchemy-effect",
    repository: "https://github.com/alchemy-run/alchemy-effect.git",
    latestRef: "main",
    version: {
      sourcePath: "infra/relay/package.json",
      packagePath: ["dependencies", "alchemy"],
      tagPrefix: "v",
    },
  },
  {
    // Read-only reference for Computer Use (docs/adr/0044). Not a dependency, so it follows main.
    id: "synara",
    prefix: ".repos/synara",
    repository: "https://github.com/Emanuele-web04/synara.git",
    latestRef: "main",
  },
];
