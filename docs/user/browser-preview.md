# Browser Preview

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

Popup-created tabs use the ordinary Browser controls. You can switch, close, capture, record,
inspect, annotate, resize, or automate them in the same way as a Browser tab opened from the plus
menu. Closing one selects the same neighboring fallback used elsewhere in the right panel.

Pathway does not bypass Chromium's popup blocker. Popups Chromium rejects as unsolicited remain
blocked, and unsupported external protocols keep their existing safe handling.
