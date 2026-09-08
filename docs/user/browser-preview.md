# Browser preview

Pathway Desktop can open a browser beside an agent thread. Browser pages appear in the same
right-panel tab strip as files, terminals, diffs, and other thread surfaces.

## Browser tabs and popups

Links and forms that open a new browsing context create another Browser tab in the same thread.
The source tab stays open with its history, scroll position, form state, and page process intact.
Normal popup clicks select the new tab, while background-tab gestures such as Cmd-click or
Ctrl-click add the tab without moving focus.

Popup-created tabs share the source browser session, including cookies and signed-in state. They
also preserve native browser behavior used by popup-dependent apps, such as `window.opener`, named
windows, `about:blank` document writes, blob URLs, referrers, and form POST bodies.

Popup-created tabs use the ordinary Browser controls. You can switch between pages, close tabs, and
resize the browser panel. A page that closes its own popup removes that tab and leaves the source
page open. Closing a source page leaves already opened tabs available.

Reloading the Pathway app closes popup-created tabs. They are not restored by loading their URL,
because that would lose the original form submission or scripted page state.

Pathway does not bypass Chromium's popup blocker. Popups Chromium rejects as unsolicited remain
blocked, and unsupported external protocols keep their existing safe handling.
