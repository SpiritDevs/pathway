# Browser settings

**Settings** > **Browser** controls the desktop app's built-in browser: where links open, saved
passwords and addresses, extensions, downloads, site permissions, and what agents may do while they
browse. It appears only in the desktop app, because only the desktop app has a built-in browser. The
remote browser that runs beside your agent on an environment is not affected by these settings.

You can also reach these pages from the browser panel's **⋯** menu and from the command palette.

## Agent control

**Let agents control the built-in browser** is the main switch. When it is off, agents cannot open,
read, or act in the built-in browser, and their downloads are refused. You can still browse
yourself.

## General

- **Import from your browser** copies saved passwords, cookies, browsing history, and extensions
  from Chrome, Chrome Beta, Chrome Canary, Chromium, Brave, Edge, Arc, Vivaldi, or Opera. Choose the
  browser profile, then what to bring across. Extensions are off by default. Close the other browser
  completely first; Pathway warns you while it is still running. Your Mac may ask for permission to
  read that browser's saved passwords.
- **Web links** chooses where links to websites open when you click them in a conversation: the
  built-in browser or your default browser. Cmd-click and other modified clicks keep their usual
  behavior, and right-clicking a link still offers both.
- **Local URLs** does the same for `localhost` and other addresses on this computer.
- **Show full URL** keeps the whole address in the address bar instead of only the site.
- **Browsing data** clears history, cookies and site data, cached files, and download history. Show
  the individual options to choose which ones.
- **Browsing history** lists every page visited in the built-in browser. Search it, filter it to
  pages an agent visited (marked **Agent**) or the rest, and remove single pages or a selection.
  **Open page** opens the page in your default browser.
- **Annotation screenshots** decides whether a comment you leave with **Annotate** attaches a
  screenshot. **Only on drag selection** attaches one only when you drag out an area or draw on the
  page. Screenshots help the agent but use more of your plan.

## Autofill and passwords

- **Password manager** adds, edits, and deletes saved sign-ins. The built-in browser offers them on
  sign-in forms.
- **Contact info** stores addresses, phone numbers, and email addresses. With **Save and fill
  addresses** on, choose **⋯** > **Passwords and autofill** > **Fill** with an address to fill the
  form on the current page.

## Extensions

**Extension manager** lists installed extensions. Choose **Load unpacked** to install an unpacked
Chrome extension folder, turn each one on or off, or remove it. Extensions you import from another
browser appear here too. Changes apply to pages you open afterward.

## Downloads

- **Location** is where downloads are saved. **Change** picks a folder; **Reset** goes back to your
  Downloads folder.
- **Ask where to save** shows a save dialog for downloads you start yourself.
- **Download history** lists downloads with their progress. Pause, resume, or cancel a download,
  open a finished file, show it in its folder, or remove it from the list. Files that were moved or
  deleted are marked **Deleted**, and files an agent downloaded are marked **Agent**.

## Permissions

- **Site settings** chooses whether websites may use your camera, microphone, location,
  notifications, clipboard, MIDI devices, pop-ups, and sound. Set a default for each. When a
  permission is set to **Ask**, the page's request opens a prompt: **Block**, **Allow this time**,
  or **Always allow**. Choices you save appear under **Sites**, where you can change or reset them.
  Unanswered requests are blocked after a short wait.
- **History approval** decides whether agents may read your browsing history: **Always ask**,
  **Always allow**, or **Disable**.
- **Enable site tools** lets agents find and call tools that websites offer to agents, including
  WebMCP tools.
- **Agent permissions** sets what agents may do on each site. The **Default** row applies everywhere
  else. For each site choose whether agents may **Browse** (allow, require approval, or block),
  **Download** files, and use **Debug (CDP)**. Add a site such as `example.com` or
  `*.example.com` to cover its subdomains. The most specific match wins. When a site requires
  approval, a prompt asks you to **Deny**, **Allow until restart**, or **Always allow**.

Agent permissions and approval prompts belong to the desktop app's built-in browser. If you follow the
thread from the web app or iOS, answer the prompt in the desktop app.

## Developer mode

**Enable full CDP access** lets agents send raw Chrome DevTools Protocol commands to the built-in
browser. It is marked **Elevated risk**: CDP can read cookies, storage, and other sensitive page
data. A site must also allow **Debug (CDP)** in **Agent permissions**.

## The new tab page

A new browser tab lists your **Pinned** pages, then the pages you **Recently visited** in the
built-in browser across all your projects, then local **Servers** that are listening. Hover a page
and use its **⋯** menu to pin it so it always appears, unpin it, or remove it from your history.

## The browser menu

The **⋯** menu in the browser panel adds **Find in page** (Enter for the next match, Shift-Enter for
the previous, Escape to close), **Print**, **Take a screenshot**, and **Float preview over chat**,
alongside **Import cookies and passwords**, **Passwords and autofill**, **Downloads**, **History**,
**Clear browsing data**, and **Browser settings**.

Once the built-in browser has downloaded something, a downloads button appears next to the
screenshot button. When a download starts, the button's arrow drops in, and a ring around the button
fills as the download progresses and flashes when it finishes. The button stays blue until you open
the list. The list shows your latest downloads. A download in progress shows its speed and a progress bar,
with buttons to pause, resume, or cancel it. Click a finished download to open it, use the folder
button to show it in its folder, or use its **⋯** menu to remove it from the list. The folder button
at the top opens your downloads folder, and **Show all downloads** opens the full download history.
