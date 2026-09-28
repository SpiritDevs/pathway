# Apple accounts and App Store Connect

Open **Settings → Apple accounts** to manage the Apple IDs, Developer teams and App Store Connect API keys Pathway uses for your apps. Everything here is stored in your Pathway account and syncs to every environment you use, so a key you connect on your desktop also works from the web app and your other machines.

## Add an Apple ID

Choose **Add Apple ID** and enter the Apple ID email and an optional display name. You can add several Apple IDs, for example a personal one and one for work. Select an Apple ID in the list to see its details.

Pathway does not sign in to your Apple ID yet, so a new Apple ID shows **Not verified yet**. Apple ID sign-in arrives with managed Xcode. You can rename an Apple ID at any time.

## Personal or shared with a company

A new Apple ID is personal, and only you can see and use it. While an organization workspace is selected, you can instead share an Apple ID with that company, either when you add it or later with **Shared with**. Company members with integration access can then use its teams and keys, and members who can manage integrations can change it.

Only the person who added an Apple ID can change who it is shared with. Unlink it from all projects before you change this; Pathway tells you when a project still uses it.

## Add Developer teams

Each Apple ID can have several Developer teams. Choose **Add team** and enter the team ID, team name and type. The team ID has ten letters or digits and appears under Membership details in your Apple Developer account.

## Connect an App Store Connect API key

Each team uses one App Store Connect API key. In App Store Connect, open **Users and Access → Integrations** and create a Team key with at least the Developer role. Then, in Pathway, choose **Connect key** on the team and enter the issuer ID and key ID. Choose the downloaded `.p8` file, or paste its contents.

Pathway checks the key with App Store Connect before saving it, then encrypts it in your Pathway account. Only the last four characters of the key ID are shown afterward. The private key is never shown again.

- **Replace key** swaps in a new key. If App Store Connect rejects the new key, the current one keeps working.
- **Revoke** removes the key. Every environment stops using it within 30 seconds.
- **Test connection** checks the key from the environment you are connected to.

Below the key, each environment that has used it recently shows whether it is connected, when it last read App Store Connect, and its most recent error. An environment connects on its first App Store Connect read and appears as idle after a short period without one.

Once a key is connected, the team lists its apps with their bundle IDs.

## Link a project to an app

Open a project's settings and find **App Store Connect**. Choose an Apple ID, then a team, then the app, and choose **Link app**. Pathway confirms that the app exists under that team before saving the link. Everyone who can see the project sees which app it is linked to. Reading builds and testers still requires access to the Apple ID. Choose **Unlink** to remove the link.

Projects must sync to a company before they can be linked.

### Create a new app

App Store Connect creates new apps only on its website. Choose **Create a new app** to open App Store Connect, and create the app there. Then return to Pathway, refresh the app list and link the new app.

## Changes from other devices

If an Apple ID or key changes on another device while you are editing, Pathway shows the latest details and asks you to try again, so an older edit never overwrites a newer one.
