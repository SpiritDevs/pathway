# File attachments

You can attach documents, code, data, archives, and other files to a chat from the paperclip
button, by dragging them into the composer, or by pasting them from the clipboard. Pathway shows
upload progress and keeps Send unavailable until every file is ready.

Files can be up to 50 MB, although a connected environment may advertise a smaller limit. Images
continue to use the image attachment flow. A newer client connected to an older environment only
offers attachment types that environment supports.

If pasted text would exceed the normal message limit, Pathway converts it to a uniquely named text
file and attaches it. When there is no attachment slot available, the file is too large, or the
environment does not support files, the original text stays in the composer instead.

File drafts store an upload marker rather than a browser copy of the file. A draft or stashed prompt
can therefore survive a reload without placing large file data in browser storage. If the temporary
upload expired or belongs to a different environment and the original browser file is no longer
available, the composer shows **Attach again**. Remove that row or select the file again before
sending.

Generic files are downloaded instead of rendered as active web content. Unknown attachment types
from a newer environment remain visible as unsupported, inert rows rather than preventing the chat
from loading.

## Viewing images

On web and desktop, click an image file link in a conversation to open a gallery over the dimmed app.
Image links in the same message appear together. Use the previous and next buttons, arrow keys,
thumbnails, or swipe horizontally to move between images. You can also scroll horizontally with a
trackpad, or hold Shift while scrolling with a mouse.

Use the zoom buttons or the `+` and `-` keys to zoom. Drag a zoomed image to pan, and click the zoom
percentage or press `0` to fit it to the window. Download saves the original image. Press Escape,
click the background, or use the close button to return to the conversation.

## Answering questions with attachments

You can paste a photo, drag a file, or use the paperclip while answering an agent's question.
On iPhone and iPad, choose **Attach to answer** to select photos or files, or paste an image.
Each question keeps its own attachments. You can submit a photo by itself or add a written answer.
Up to eight files can be attached across one set of answers.

Submit waits until every upload finishes. If an upload fails, retry it or remove the attachment.
Completed uploads survive a reload; an interrupted or expired upload may need to be attached again.
Submitted photos and file links remain with the answers in conversation history.

The files are uploaded to the environment running your agent, so this works when you connect
remotely too. Codex and Claude can open the saved files when processing your answer. Attachments
are available for questions that allow a custom answer, on environments that support this feature.
