import { routes, type VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @spiritdevs/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@spiritdevs/scripts...' --filter '@spiritdevs/web...'",
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
  // Vite content-hashes everything under /assets, so a URL never changes meaning.
  headers: [
    routes.header("/assets/(.*)", [
      { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
    ]),
  ],
};
