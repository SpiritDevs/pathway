import type { ReactNode } from "react";
import type { Components } from "react-markdown";

/**
 * The block tags whose text runs through chat's inline transforms — issue mentions and skill chips —
 * but that otherwise render exactly as react-markdown would.
 *
 * Paragraphs and list items carry overrides of their own; these are the rest of the shapes an agent
 * summary puts keys in. A heading that says "ISS-30 is done", or a table cell listing the issues a
 * turn touched, links the same way a sentence does — the server records the mention either way, so
 * a message that hides it would be lying about what it just filed.
 */
export function inlineChildrenComponents(
  render: (children: ReactNode) => ReactNode,
): Pick<Components, "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "td" | "th"> {
  return {
    h1: ({ node: _node, children, ...props }) => <h1 {...props}>{render(children)}</h1>,
    h2: ({ node: _node, children, ...props }) => <h2 {...props}>{render(children)}</h2>,
    h3: ({ node: _node, children, ...props }) => <h3 {...props}>{render(children)}</h3>,
    h4: ({ node: _node, children, ...props }) => <h4 {...props}>{render(children)}</h4>,
    h5: ({ node: _node, children, ...props }) => <h5 {...props}>{render(children)}</h5>,
    h6: ({ node: _node, children, ...props }) => <h6 {...props}>{render(children)}</h6>,
    td: ({ node: _node, children, ...props }) => <td {...props}>{render(children)}</td>,
    th: ({ node: _node, children, ...props }) => <th {...props}>{render(children)}</th>,
  };
}
