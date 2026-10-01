# Releases and the Organizer

Releases archives a project on a Mac environment, uploads the build to App Store Connect, sends it to TestFlight testers and submits it for App Review. The Organizer shows your builds, testers, review status and the archives on each Mac.

Open Releases in any of these ways:

- **Releases** at the top of a project's dashboard
- **Open Releases** or **Open Organizer** in the command palette, then choose a project
- **Open Releases** under a team's apps in **Settings → Apple accounts**

Releases works from the web app and the desktop app. The work runs on the environment's Mac, so you can start an archive from your laptop or from app.spiritdevs.com.

## Before you start

- Link the project to an App Store Connect app. If it is not linked yet, Releases shows the same **App Store Connect** picker as the project's settings. See [Apple accounts](apple-accounts.md).
- Connect to an environment that has the project and runs on a Mac with Xcode. See [Xcode](xcode.md).

## Publishing is off until you turn it on

Each app has a **Publishing** switch. It is off for every app until someone turns it on, either at the top of Releases or next to the app in **Settings → Apple accounts**. The setting lives in your Pathway account, so it applies on every device and environment.

With publishing off you can still archive and prepare uploads, but nothing is sent to Apple. Turning it on does not send anything by itself. Every upload and submission still waits for you to confirm it. Turn it on only for apps you are ready to send to testers or to App Review.

## Archive

Under **Archive**, enter:

- **Project or workspace**: the `.xcodeproj` or `.xcworkspace` path, relative to the project folder on that environment
- **Scheme**
- **Version**, such as `1.4` or `1.4.2`
- **Platform**

Choose **Archive**. Pathway picks the next build number for you, so two Macs never reuse one. Progress appears under **Activity**. An environment runs one release job at a time. Choose **Stop** to cancel a running job. If an archive fails, choose **Try again** to rerun it with the same details.

When the project is open on more than one Mac, choose which one to use next to the tabs.

## Upload

Each finished archive is listed under **Upload** with its version, build number, scheme and size. Choose **Upload…** to prepare the upload, then confirm it.

While a build uploads, Activity shows how much has been sent. When the upload finishes, Apple processes the build. This usually takes a few minutes. Choose **Refresh** to check.

## Confirm before anything is sent

Every upload, TestFlight change and App Review submission opens a confirmation that shows exactly what will be sent: the app, the team, the Mac it runs on and every detail of the request. Nothing reaches Apple until you choose the confirm button.

- **Discard** throws the request away.
- A confirmation expires after 15 minutes and can be used only once. After that, prepare it again.
- If the Mac that prepared the request is not connected, connect to it first. Apple receives the build from that Mac.

Agents can prepare a release, but only you can confirm and send it. If publishing is turned off, requests prepared earlier can no longer be sent. Prepare them again after turning it back on.

If something fails after you confirm, Pathway does not try again on its own, because Apple may have received part of the request. Check the Organizer, then prepare the request again if needed.

## TestFlight

Under **TestFlight**, choose a processed build and the groups that should get it. Enter **What to test** and the language it is written in. Turn on **Submit for beta review** to send the build to external testers. Apple must review a build before external groups can install it. Choose **Review and send…**, then confirm.

## App Review

Create the App Store version in App Store Connect first. Then, under **App Store review**, choose a processed build and the version, choose **Review and submit…**, and confirm. Pathway attaches the build to the version and submits it for review.

## Organizer

Choose the **Organizer** tab to see:

- **Builds**: version and build number, processing state, beta review state, internal and external TestFlight state, upload date and expiry
- **TestFlight**: your groups and testers
- **App Store**: each version with its build and state, and your review submissions
- **Local archives**: the archives on each connected Mac, labeled with the environment's name, with **Upload…** on each

Long lists show 10 items per page. The Organizer updates only while it is on screen. Choose **Refresh** to fetch the latest from App Store Connect.

The iOS app does not show Releases or the Organizer yet.
