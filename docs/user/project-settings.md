# Project settings

Open **Settings → Projects** to see every project and how many machine connections it has. Hover
the connection count to see each environment name, directory, platform, Pathway version, and
binding status.

Select a project and open **Connections** for the full list. Each connection identifies the
machine or environment, its attached directory, availability, environment ID, and last-seen time.
When a project has several active connections, **New-thread default** marks the environment Pathway
will use automatically.

## Customize a project icon

Pathway selects a project icon automatically. It checks `t3.json`, common favicon and app icon
paths, and icon links in project HTML files.

To choose a different icon:

1. Open **Settings** and select **Projects**.
2. Select the project.
3. Under **Appearance**, select **Choose a project file**.
4. Search for an image file and select it.

Pathway supports SVG, PNG, ICO, JPEG, GIF, AVIF, and WebP files. The selected path applies to
each checkout in the project group and appears on your connected clients.

To use automatic detection again, select **Automatic**.
