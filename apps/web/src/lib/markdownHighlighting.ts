import HighlightWorker from "./markdownHighlighting.worker?worker";
import { MarkdownHighlightQueue } from "./markdownHighlightQueue";

export { markdownHighlightKey } from "./markdownHighlightQueue";
export const markdownHighlights = new MarkdownHighlightQueue(() => new HighlightWorker());
