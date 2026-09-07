# Connect a server from iPhone, iPad or Apple Vision Pro

Open **Connect a server** while signed in. Paste a pairing link from Pathway on your computer, or enter the server's network address and pairing token. Keep both devices on a network where the server is reachable.

Use an administrator pairing link when linking a server to your Pathway Connect account. A normal pairing link may allow you to read and control work while leaving account and tunnel settings unavailable.

Choose **Connect from anywhere** to set up Pathway Connect. Pathway installs the tunnel client on the server when needed. Turn this option off to use the server's direct network address from this device.

Choose the workspace and select the local projects you want to add. Projects are unselected initially. Registering the server alone does not share all its local projects. Selected projects and their synced history become available under that workspace's permissions. A project with a matching repository joins the workspace's existing project.

After registration, projects and threads appear as the server syncs. Keep the server running and connected to the internet. If setup fails after some projects were added, retrying preserves those completed additions.

## Change or remove a connection

For a server with a managed tunnel, switch between **Use Pathway Connect on this device** and **Use direct access on this device**. Successful tunnel setup initially chooses Pathway Connect so the app can reconnect after you leave the local network.

- **Remove saved direct session** removes this device's saved server access. It does not unlink the server or remove workspace history.
- **Remove from account** revokes the Pathway Connect account link and tunnel, including when the server is offline. The server may still show its old local link until you unlink it there.
- **Unlink server** stops that server's cloud publishing and tunnel for every device, then removes its account connection. Workspace projects and history remain.

Saved sessions are separated by signed-in account. When a direct session expires, create a new pairing link and pair again. Update an older server before setting up its account link remotely; older versions require that step from the desktop.
