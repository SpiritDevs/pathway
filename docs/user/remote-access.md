# Remote Access

Use this when you want to connect to a Pathway server from another device such as a phone, tablet, or separate desktop app.

## Quick Pairing for a Running Server

If a server is already running on this machine, mint a fresh pairing token and QR code without restarting anything:

```bash
npx @spiritdevs/pathway pair
```

`pathway pair` finds the running server (the shared `~/.pathway` install, or the current worktree's dev server when run inside one), issues a one-time pairing token, and prints the pairing URL as a QR code you can scan from your phone.

If the server is only bound to loopback, the printed URL is not reachable from another device. Enable Pathway Connect for managed remote access, or bind the server to a reachable private-network address for direct access.

If no server is running, `pathway pair` says so and points you at `npx @spiritdevs/pathway serve` or `npx @spiritdevs/pathway connect`.

## Recommended Setup

Use Pathway Connect for remote access without opening inbound ports or managing a separate network.

That gives you:

- a stable HTTPS endpoint
- encrypted transport through a managed Cloudflare tunnel
- no inbound port forwarding

## Enabling Network Access

There are three ways to reach your server from another device: use Pathway Connect, expose a direct
private-network endpoint, or have the desktop app launch Pathway over SSH.

### Option 1: Desktop App

The desktop app enables network access automatically. To pair another device:

1. Open **Settings** → **Environments**.
2. The settings panel shows the reachable endpoints for this environment.
3. Use **Create Link** to generate a pairing link you can share with another device.

Under **Devices with access**, currently connected devices remain visible. Disconnected devices are
grouped under a collapsed **Disconnected** section, where you can revoke one device or revoke all
disconnected devices at once. Relaunching the desktop app replaces its previous internal session
instead of creating another device entry. Revoked devices need a new pairing link before they can
reconnect.

Connected environments stay visible in the **Environments** list. Saved environments that are not
currently reachable through Pathway Connect are grouped under the collapsed **Disconnected** section.
The screen refreshes live relay health while it is open, so closing or reopening a host is reflected
without changing its workspace registration. You can reconnect one environment, remove it, or remove
all disconnected environments at once. For locally saved environments, removal only changes this
client's catalog. In a company workspace, removal deactivates the workspace registration. Neither
action deletes the environment's server, projects, or other data.

The default endpoint controls the QR code and primary copy action for pairing links. You can change it from the expanded endpoint list. The preference is stored by endpoint type, so choosing the local LAN endpoint survives normal IP address changes when you move between networks.

When no user default is saved, the app uses the built-in LAN endpoint for pairing links when
available. You can set another endpoint as the default from the expanded endpoint list.

- HTTPS/WSS-compatible endpoints work from `https://app.spiritdevs.com`, but are not made the default
  automatically.
- Non-loopback HTTP endpoints are useful for direct LAN pairing.
- Loopback-only endpoints are not useful for another device unless that device is the same machine.

If the copied link points directly at `http://192.168.x.y:3773`, open it from a client that can reach that LAN address. If it points at `https://app.spiritdevs.com/pair?...`, the hosted web app will save the environment and connect directly to the backend URL in the link.

In the mobile app's **Add Environment** form, a numeric IP address without a scheme uses HTTP. Include `https://` explicitly when the backend is served over HTTPS.

### Option 2: Headless Server (CLI)

Use this when you want to run the server without a GUI, for example on a remote machine over SSH.

Run the server with `pathway serve`.

```bash
npx @spiritdevs/pathway connect
npx @spiritdevs/pathway serve
```

`pathway serve` starts the server without opening a browser and prints:

- a connection string
- a pairing token
- a pairing URL
- a QR code for the pairing URL

From there, connect from another device in either of these ways:

- scan the QR code on your phone
- in the desktop app, enter the full pairing URL
- in the desktop app, enter the host and token separately
- in the hosted web app, open a hosted pairing URL when the backend is reachable over HTTPS

Use `pathway serve --help` for the full flag reference. It supports the same general startup options as the normal server command, including an optional `cwd` argument.

`pathway connect` authorizes the environment and records that it should use Pathway Connect. The
next `pathway serve` start provisions or reattaches the managed tunnel. Use `pathway connect status`
to inspect it and `pathway connect unlink` to disable remote access.

Once paired, add projects normally: open the Command Palette and choose **Add Project**, then pick
the environment the project lives on. Every saved environment is offered, not only the local one.

### Option 3: Desktop-Managed SSH Launch

Use this when you want the desktop app to start or reuse Pathway on another machine over SSH.

1. Open **Settings** → **Environments**.
2. Beside **Environments**, choose **Add environment**.
3. Select the SSH launch flow.
4. Enter the SSH target, such as `user@example.com`.
5. Confirm the launch. The desktop app probes the host, starts or reuses a remote Pathway server, opens a local port forward, and saves the environment.

After setup, the renderer connects to a local forwarded HTTP/WebSocket endpoint. The remote host still owns the actual Pathway server, projects, files, git state, terminals, and provider sessions.

SSH launch is a desktop feature because it needs local process and SSH access. Once the environment is paired and saved, it uses the same environment list and connection model as direct LAN, HTTPS, or Pathway Connect environments.

#### SSH Launch Troubleshooting

The desktop SSH launcher connects with a non-interactive `sh` session, writes a small launcher script under `~/.pathway/ssh-launch/<host-key>/`, starts or reuses a remote Pathway server, and forwards the remote loopback port back to your desktop.

The remote host must have a compatible Node.js runtime. Pathway uses the server package's `engines.node` requirement:

```text
^22.16 || ^23.11 || >=24.10
```

During SSH launch, Pathway first checks whether `node` is on `PATH`. If it is missing, the launcher
looks in the usual install directories and tries to activate a version manager if it finds one
(Volta, asdf, mise, fnm, nodenv, nvm). That covers most setups, but a version manager that only
initializes from an interactive shell profile will not be picked up.

If launch fails with `node: command not found`, a port-scan failure, or a message that the remote Node version does not satisfy the required range, SSH into the host and check the same non-interactive shell path Pathway uses:

```bash
ssh user@example.com 'sh -lc "command -v node && node --version"'
```

If that does not print a compatible Node version, configure your version manager for non-interactive shells or install a compatible Node binary in one of the searched locations. For example, with nvm you may need a default alias:

```bash
nvm alias default 24
```

With mise, asdf, fnm, or nodenv, make sure the tool's shim directory is installed and resolves to a Node version satisfying the range above without an interactive shell.

If reconnecting after an app update fails, retry the SSH launch once. The launcher now compares its generated runner script, stops stale launcher-managed remote servers, clears the SSH launch PID/port state, and starts a fresh remote server. You should not normally need to delete `~/.pathway/ssh-launch` or kill `pathway` processes manually.

## Updating a Remote Server

When the Pathway web or desktop app and a remote server use different versions, a warning appears in
the conversation and in **Settings** → **Environments**. Follow the action shown there: Pathway may
be able to update and reconnect the server for you, or it may ask you to update the desktop app or
run a copied command on the server machine.

Finish active work before updating because the server restarts briefly. For step-by-step guidance,
see [Keeping Pathway in Sync](./updating.md).

On a Linux host, you can keep the server running after logout and manage it independently of the
connection method. See [Running Pathway in the Background](./background-service.md).

## How Pairing Works

The remote device does not need a long-lived secret up front.

Instead:

1. `pathway serve` issues a one-time owner pairing token.
2. The remote device exchanges that token with the server.
3. The server creates an authenticated session for that device.

After pairing, future access is session-based. You do not need to keep reusing the original token unless you are pairing a new device.

## Hosted Web App Pairing

The hosted web app at `https://app.spiritdevs.com` can save a remote backend in browser local storage from a URL like:

```text
https://app.spiritdevs.com/pair?host=https://backend.example.com:3773#token=PAIRCODE
```

Use hosted pairing when the backend is reachable from the browser over HTTPS/WSS. This includes a backend behind a trusted HTTPS tunnel or another HTTPS endpoint you operate.

Do not use hosted pairing for plain HTTP LAN URLs such as `http://192.168.x.y:3773`. Browsers block an HTTPS page from connecting to an insecure HTTP or WS backend. For those endpoints, use the direct pairing URL shown by the desktop app or CLI from a client that can open that HTTP URL directly.

Hosted pairing does not proxy traffic through Pathway. The browser still connects directly to the backend URL in the pairing link.

## Managing Access Later

Use `pathway auth` to manage access after the initial pairing flow.

Typical uses:

- issue additional pairing credentials
- inspect active sessions
- revoke old pairing links or sessions

Use `pathway auth --help` and the nested subcommand help pages for the full reference.

## Security Notes

- Treat pairing URLs and pairing tokens like passwords.
- Prefer Pathway Connect for remote access. If you bind `--host` directly, use a trusted private address instead of exposing the server broadly.
- Anyone with a valid pairing credential can create a session until that credential expires or is revoked.
- Hosted pairing links keep the credential in the URL hash so it is not sent to the hosted app server, but it can still be exposed through browser history, screenshots, logs, or copy/paste.
- Use `pathway auth` to revoke credentials or sessions you no longer trust.
