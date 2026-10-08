import type { ProxyOptions } from "vite";

/** Where single-origin dev serves a loopback Cyndrbase engine to the browser. */
export const LOCAL_CYNDRBASE_PATH = "/cyndrbase";

/**
 * Proxies only the engine routes a browser uses: the Convex sync socket and function calls, and file
 * downloads. Deploy and environment RPCs, bundle uploads, the data browser and the uploadfile commit
 * callback stay unreachable from the shared dev origin, which a tunnel or LAN may expose.
 */
export function localCyndrbaseProxy(target: string): Record<string, ProxyOptions> {
  const routes = String.raw`api/(\d[^/]*/sync|query|query_ts|query_at_ts|mutation|action|function)(\?|$)|\.files/download/`;
  return {
    [`^${LOCAL_CYNDRBASE_PATH}/(${routes})`]: {
      target,
      changeOrigin: true,
      ws: true,
      rewrite: (path) => path.slice(LOCAL_CYNDRBASE_PATH.length),
    },
  };
}

/**
 * Vite's default `server.fs.deny`, which a configured list replaces, plus Pathway's own state:
 * worktree homes and the local engine's deploy key under `.pathway` are never served by `/@fs/`.
 */
export const DEV_FS_DENY = [
  ".env",
  ".env.*",
  "*.{crt,pem,key,p12,pfx,cer,der}",
  ".npmrc",
  ".yarnrc.yml",
  "**/.git/**",
  "**/.pathway/**",
];
