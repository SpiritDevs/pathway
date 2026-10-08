import type { ProxyOptions } from "vite";

/** Where single-origin dev serves a loopback Cyndrbase engine to the browser. */
export const LOCAL_CYNDRBASE_PATH = "/cyndrbase";

// The engine routes a browser uses: the Convex sync socket and function calls, and file downloads
// (`/.files/download/<id>/<base64url signature>`). Segments are spelled only from characters that
// decoding and dot-segment resolution leave alone, so the path checked is the path the engine gets:
// `..`, `%2e`, `%2f` and `//` never match.
const ROUTE = new RegExp(
  String.raw`^${LOCAL_CYNDRBASE_PATH}/(api/(\d[\w.-]*/sync|query|query_ts|query_at_ts|mutation|action|function)|\.files/download/[\w-]+/[\w-]+)(\?|$)`,
);

/**
 * Proxies only those routes. Deploy and environment RPCs, bundle uploads, the data browser and the
 * uploadfile commit callback answer 404 on the shared dev origin, which a tunnel or LAN may expose.
 */
export function localCyndrbaseProxy(target: string): Record<string, ProxyOptions> {
  return {
    [`${LOCAL_CYNDRBASE_PATH}/`]: {
      target,
      changeOrigin: true,
      ws: true,
      // Vite runs this on the raw request target, for WebSocket upgrades too; false answers 404.
      bypass: (request) => (ROUTE.test(request.url ?? "") ? undefined : false),
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
