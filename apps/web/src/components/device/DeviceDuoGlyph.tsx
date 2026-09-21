import type { DuoPose } from "@spiritdevs/client-runtime/device/duo-control";

/** Simple original diagrams of the available folding postures. */
export function DeviceDuoGlyph({ pose }: { pose: DuoPose }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-7 shrink-0"
      aria-hidden
    >
      {pose === "closed" ? <rect x="6" y="3" width="12" height="18" rx="2" /> : null}
      {pose === "open" ? (
        <>
          <rect x="2" y="4" width="20" height="16" rx="2" />
          <path d="M12 4v16" />
        </>
      ) : null}
      {pose === "book" ? <path d="M12 5 3 3v16l9 2 9-2V3l-9 2v16" /> : null}
      {pose === "laptop" ? <path d="m4 3 2 12h13L17 3H4ZM6 15l-3 5h15l1-5" /> : null}
      {pose === "tent" ? <path d="m3 20 8-16 10 16H3Zm8-16 2 16" /> : null}
    </svg>
  );
}
