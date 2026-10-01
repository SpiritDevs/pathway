# Apple accounts and App Store Connect

Open **Settings → Apple accounts** to manage the Apple IDs, Developer teams and App Store Connect API keys Pathway uses for your apps. Everything here is stored in your Pathway account and syncs to every environment you use, so a key you connect on your desktop also works from the web app and your other machines.

## Add an Apple ID

Choose **Add Apple ID**, enter the Apple ID email and choose **Continue**. Then sign in with the Apple ID password and the verification code Apple sends to your devices or phone. Pathway signs in from the environment chosen next to **Test and list apps on**, then adds every Developer team on that Apple ID for you. Your password is used for that sign-in only and is never stored.

You can add several Apple IDs, for example a personal one and one for work. Select an Apple ID in the list to see its details. Until it is signed in, an Apple ID shows **Not signed in** and asks for its password when you select it. Entering an Apple ID that is already in the list opens that one instead.

When your teams change, choose **Refresh teams** and sign in again. Every Apple ID starts with its email as its name; rename it at any time.

## Personal or shared with a company

A new Apple ID is personal, and only you can see and use it. While an organization workspace is selected, you can instead share an Apple ID with that company, either when you add it or later with **Shared with**. Company members with integration access can then use its teams and keys, and members who can manage integrations can change it.

Only the person who added an Apple ID can change who it is shared with. Unlink it from all projects before you change this; Pathway tells you when a project still uses it.

## Developer teams

Signing in adds each Developer team on the Apple ID, with its name and type. Apple ID sign-in does not support hardware security keys, federated work accounts or Apple's own account notices. For those Apple IDs, or a team Apple did not list, choose **Add team** and enter the team ID, team name and type yourself. The team ID has ten letters or digits and appears under Membership details in your Apple Developer account.

To remove a team, choose **Remove team** on it and confirm. This removes the team and its API key from every environment. Unlink any projects that use the team first; Pathway tells you when one still does.

## Connect an App Store Connect API key

Each team uses one App Store Connect API key. In App Store Connect, open **Users and Access → Integrations** and create a Team key with at least the Developer role. Then, in Pathway, choose **Connect key** on the team and enter the issuer ID and key ID. Choose the downloaded `.p8` file, or paste its contents.

Pathway checks the key with App Store Connect before saving it, then encrypts it in your Pathway account. Only the last four characters of the key ID are shown afterward. The private key is never shown again.

- **Replace key** swaps in a new key. If App Store Connect rejects the new key, the current one keeps working.
- **Revoke** removes the key. Every environment stops using it within 30 seconds.
- **Test connection** checks the key from the environment chosen next to **Test and list apps on**.

Below the key, each environment that has used it recently shows whether it is connected, when it last read App Store Connect, and its most recent error. An environment connects on its first App Store Connect read and appears as idle after a short period without one.

Once a key is connected, the team lists its apps with their bundle IDs.

When you are connected to more than one environment, including remote ones, choose which one tests keys and lists apps with **Test and list apps on**. It starts on your main environment.

## Link a project to an app

Open a project's settings and find **App Store Connect**. Choose an Apple ID, then a team, then the app, and choose **Link app**. The app list comes from the environment that holds the project. Pathway confirms that the app exists under that team before saving the link. Everyone who can see the project sees which app it is linked to. Reading builds and testers still requires access to the Apple ID. Choose **Unlink** to remove the link.

Projects must sync to a company before they can be linked.

Once a project is linked, use [Releases](releases.md) to archive it and send builds to TestFlight and App Review. Each app's **Publishing** switch is listed next to it under the team, and is off until you turn it on.

### Create a new app

App Store Connect creates new apps only on its website. Choose **Create a new app** to open App Store Connect, and create the app there. Then return to Pathway, refresh the app list and link the new app.

## Changes from other devices

If an Apple ID or key changes on another device while you are editing, Pathway shows the latest details and asks you to try again, so an older edit never overwrites a newer one. While you are entering a new key, Pathway pauses the form until you confirm you have reviewed the change.

If connecting a key fails, Pathway clears the private key you entered. The issuer ID and key ID stay filled in, so choose the `.p8` file again to retry.
