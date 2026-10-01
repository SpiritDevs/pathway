# Xcode

iOS, watchOS and tvOS simulators need Xcode on the Mac that runs your environment. Pathway can download and install Xcode for you, from any device you use Pathway on. Installing from the web app or your laptop sets up the environment's Mac, not the device in front of you.

Open **Settings → Xcode**, or search the command palette for **Install Xcode**. When an environment runs on a Mac without Xcode or without an iOS simulator, the Devices view shows the same setup above the device list. Android devices stay available while Xcode installs.

Xcode needs a Mac. When the environment runs on Linux or Windows, Pathway says so and offers nothing to install.

## Choose the environment and Apple ID

When you are connected to more than one environment, choose the Mac with **Manage Xcode on**. Pathway shows that environment's name and, when the Mac reports them, its model and hostname.

Xcode downloads come from Apple and need an Apple ID. Choose one of your [Apple accounts](apple-accounts.md). If you have none, Pathway links to **Settings → Apple accounts** so you can add one first. Pathway remembers which Apple ID you used on each environment.

## Sign in to your Apple ID

Enter your Apple ID password and choose **Sign in**. The password is sent to the environment for this sign-in only. Pathway does not store it.

Apple then asks for a verification code:

- **On your other Apple devices**: enter the code shown on your iPhone, iPad or Mac.
- **By text message**: enter the code Apple texted you. Choose **Send code** to resend it or to use another phone number.
- **Choose a phone**: when Apple asks, pick which number receives the code, then choose **Text me a code**.

The code request expires after ten minutes. Pathway shows when it expires. After that, choose **Start again**. Choose **Cancel** at any point to stop signing in.

Everyone watching the same environment sees the same code request, so you can start signing in on the web app and finish on your laptop.

After signing in, Pathway keeps the Apple session in your Pathway account so the environment can resume long downloads. Choose **Sign out** under **Apple ID** in Settings → Xcode to end it. Hardware security keys, federated work accounts and Apple's own account notices are not supported here. Sign in on apple.com to resolve those first.

## Install Xcode

Choose a version. The newest release is listed first and marked **Recommended**. Older releases and betas follow. Then choose the simulator platforms to add. iOS is selected by default.

Pathway shows how much space the install needs next to how much is free on the Mac. Xcode itself reserves 45 GB, and each platform adds 15 GB. If the Mac lacks space, free some and try again.

Choose **Install Xcode**. Pathway then works through each step and shows its progress:

1. Check the Mac
2. Download Xcode, with size, speed and time remaining
3. Expand and verify
4. Move to Applications
5. Accept the license
6. Select Xcode
7. Install components
8. Download platforms
9. Install device support

The install runs on the Mac, so you can close Pathway or disconnect while it continues. Reopen Settings → Xcode or the Devices view to see where it is.

### Admin approval on the Mac

Some steps need an administrator on the Mac. The job then shows **Needs admin approval on the Mac**. Choose **Approve on the Mac** to open a macOS password prompt on that Mac, not on the device you are using. Someone at the Mac enters an administrator password there. Pathway never sees it.

### Cancel, retry and sign in again

- **Cancel** stops the job. Choose **Resume** later to pick it up again.
- If a step fails, or the environment restarts during a job, choose **Retry** to continue from the first unfinished step.
- If your Apple session expires during a download, Pathway asks you to sign in again. Once you are signed in, choose **Retry**. If Apple rejects a session that still shows as signed in, choose **Sign in again** first.

Canceling cannot undo steps that already finished, such as accepting the license or selecting Xcode.

When the install finishes, the Devices view refreshes and shows your simulators. If Xcode is ready but has no iOS platform yet, the setup offers to add it.

## Switch Xcode versions

**Installed Xcodes** lists every Xcode on the Mac with its version, build and location. The one tools use is marked **Selected**. Choose **Select** on another Xcode to switch, and select the previous one to switch back.

## Add platforms

**Platforms** lists the simulator platforms installed on the Mac. To add more, choose platforms under **Add platforms to Xcode** and choose **Add platforms**. Pathway downloads the current platform for the selected Xcode.

## One job at a time

Each Mac runs one Xcode job at a time. To start another install, finish or cancel the current job. If someone else is installing with a different Apple ID, Pathway tells you the Mac is busy.

## On iPhone, iPad and Vision Pro

Open **Settings → Xcode** in the Pathway app and choose the environment under **Manage Xcode on**. Everything above works the same way: sign in to your Apple ID, install a version, approve admin prompts on the Mac, cancel, retry, switch versions and add platforms. The screen updates only while it is open.

Admin approval still happens on the Mac itself. Approving from your phone opens the macOS password prompt on that Mac, so someone there needs to enter an administrator password.

To add an Apple ID to Pathway, use Settings → Apple accounts in the web or desktop app. Once added, it appears in the mobile app.
