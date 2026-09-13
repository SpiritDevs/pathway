/** Standalone Vite development entry; no production router, identity or backend runtime. */
import { createRoot } from "react-dom/client";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import "../../index.css";
if (import.meta.env.DEV) {
  const { AssetReviewFixture } = await import("./AssetReviewFixture");
  const root = document.getElementById("root");
  if (root)
    createRoot(root).render(
      <AppAtomRegistryProvider>
        <AssetReviewFixture />
      </AppAtomRegistryProvider>,
    );
}
