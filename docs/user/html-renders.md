# Visual replies

Agents can answer with a page instead of only text: a chart, table, diagram, image collage, or mockup. Ask for one ("show this as a chart", "lay these screenshots out side by side") and the agent builds a self-contained page. It appears in the conversation above the agent's written reply and stays there when the turn folds into **Worked for…**. Visual replies work in conversations Pathway starts with Codex, Claude, Cursor, Grok, and OpenCode, and you can view them on web, desktop, iPhone, and iPad.

Only agents working directly with you make pages. Subagents and work handed off by an orchestrator report back in text, so their findings reach you through the agent you are talking to.

On web and desktop, pages use your current theme, including custom themes and fonts, and follow light and dark mode as you switch. On iPhone and iPad, pages use the system colors and follow your appearance setting.

A page takes the height its content needs at your window's width. When the agent chose a smaller frame for long content, the rest scrolls inside the page.

## Open a page full size

On web and desktop, point at a page and choose **Open full size**. The full-size view has **Open in browser**, which opens the page in your browser, and a close button. Esc also closes it while Pathway has keyboard focus. On a touch screen the button is always visible.

On iPhone and iPad, tap the expand button in the page's corner to view it full screen, then tap **Done**. Pages reload when you scroll away and return, so changes you made inside a page may reset.

## Links and keyboard

Links you click in a page open in your browser; the page itself stays in the conversation. On iPhone and iPad, tap a link to open it; activating it with a hardware keyboard does not open the browser. A page cannot open windows or dialogs on its own.

Clicking into a page gives it keyboard focus, so Pathway's keyboard shortcuts wait until you click back into the app.

## Safety and storage

Scripts run inside the page, but it is sandboxed away from Pathway, your session, and your other conversations. A page can load public resources from the web, such as a charting library.

The agent publishes a copy of the page into the conversation. Images from the agent's workspace are embedded in that copy, so the page keeps working after the workspace changes. Deleting the conversation deletes its pages. A forked conversation shows the pages from the conversation it came from.

## When a page does not load

A page loads from the environment that owns the conversation, including remote environments and Pathway Connect. Connect to that environment to view it. If a page shows **Unable to load**, check the connection and choose **Retry**. If it shows an error inside the page, use **Reload page** in its corner or full-size header. On iPhone and iPad, tap **Page unavailable** to reload it.

While the agent is still publishing a page, or if publishing failed, the step appears in the conversation's work details instead.

## Visual replies and visualization cards

[Visualization cards](./visualizations.md) link to a live HTML file in the agent's workspace and open it in a browser. Visual replies are stored copies shown inline in the conversation.
