# Snapshot editor interaction evidence

The before/after screenshots and short video use the isolated editor fixture with a saved
capture. The video exercises button-edge clicks and the responsive toolbar layout. It does not
show live screen acquisition or a signed-in chat flow.

Native Electron verification separately checked the transparent region selector, Retina pixel
coordinates, drag completion, and Escape cancellation. The test runtime lacked macOS Screen
Recording permission, so live acquisition was not verified.
