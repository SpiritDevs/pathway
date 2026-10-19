# Images in agent messages

Agents can show images saved inside the workspace of their thread. Pathway reads the file from that thread's environment and gives the client temporary access to it. The same message works when viewed remotely; the client does not need a copy of the file.

Save the image in the thread's workspace, then use inline Markdown:

```markdown
![Screenshot showing the updated layout](.pathway/evidence/layout.png)
```

Relative paths resolve inside the thread's project directory, worktree, or conversation directory. An absolute path must point inside that same directory. Paths refer to the environment's filesystem, including Windows environments.

For names with spaces, put the destination in angle brackets or encode the spaces. Encode literal `%`, `#`, and `?` in filenames as `%25`, `%23`, and `%3F`:

```markdown
![Layout](<.pathway/evidence/你好 layout.png>)
![Layout](.pathway/evidence/layout%231.png)
![Windows layout](file:///C:/workspace/screens/layout.png)
```

Use `file:` for an absolute path under an unusual filesystem root. A slash-prefixed reference such as `/images/logo.png` may be a website URL; it is not automatically treated as an environment file. Native clients have no website origin for those ambiguous URLs, so use an explicit workspace path or HTTPS URL.

Ordinary HTTPS images and images linked to HTTPS pages continue to work:

```markdown
[![Diagram](https://example.com/diagram.png)](https://example.com/details)
```

Images fit the message width. Open an image to inspect it at a larger size. If it cannot load, check the environment connection and file access, then retry. Reopening a message obtains fresh access when necessary.

Keep the original path in the message. Do not replace it with a temporary `/api/assets/` URL. The file must remain available: deleting it, removing its worktree, or cleaning a temporary directory makes the image unavailable. Pathway does not automatically archive files mentioned in Markdown.

Files outside the authorized thread workspace, including symlinks that escape it, cannot be shown through a Markdown path. Move or copy a generated image into the workspace while it still exists, or use Pathway's existing image attachment flow. Provider-specific references such as `sandbox:` are unavailable unless the provider supplies an actual accessible attachment. This feature does not import arbitrary temporary files.

Use inline `![alt](path)` syntax for images shared with native Apple clients. Reference-style image definitions are currently supported by the web and desktop renderer only.
