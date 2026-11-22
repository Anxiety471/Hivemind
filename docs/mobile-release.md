# Mobile builds and store releases

Rakazo's public repository does not contain production App Store Connect,
Google Play, Apple team, or private EAS submission identifiers. Those values
belong in the release operator's private configuration.

Self-hosters normally do not need to publish their own mobile app: the Rakazo
client can select a compatible server from the sign-in screen. If you distribute
your own branded build, use your own Expo and store accounts.

## Configure a build

1. Link `apps/mobile` to an Expo project owned by your account.
2. Choose unique iOS and Android application identifiers.
3. Configure `EXPO_PUBLIC_API_URL` in the EAS build environment. Production
   builds require a valid HTTPS URL.
4. Keep store application IDs, team IDs, signing credentials, API keys, and
   review-account credentials out of Git.
5. Before a native iOS or Android build, run
   `pnpm --filter @rakazo/mobile exec expo install --check`. Attachment pickers
   and other Expo native modules must match the SDK (SDK 57 needs
   `expo-image-picker@~57.0.11`, not 17.x). Use `pnpm exec expo install --fix`
   from `apps/mobile` if that check fails.

From `apps/mobile`:

```sh
eas project:init
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://app.example.com --visibility plaintext
eas build --platform ios --profile production
eas submit --platform ios --profile production --latest
```

EAS can prompt for store identity interactively. For automated submission, add
the required identifiers through a private CI configuration or a short-lived
local change that is never committed.

Before submission, verify the production API, account deletion, sign-in,
notifications, store privacy answers, age rating, screenshots, support page,
and review account on a physical device.

## Release

Bump `expo.version` in `apps/mobile/app.json` when native code changes (see
Over-the-air updates below), then run the `release-mobile` workflow from `main`
with the App Store "What's New" text. It builds iOS on EAS, uploads it to App
Store Connect, puts the build on that App Store version with the notes, and
submits it for review; Apple releases it once approved. The same run submits a
production Android App Bundle to Google Play for review and publishes the
Android APK below. The stores review independently, so publication times differ.

It needs these repository secrets:

- `EXPO_TOKEN`: an Expo access token for the project.
- `ASC_APP_ID`: the app's Apple ID, shown under App Information in App Store
  Connect.
- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY`: an App Store Connect API
  key with the App Manager role, from Users and Access > Integrations. The
  private key is the contents of the downloaded `.p8` file.

Re-running it for a version that is already in review leaves that submission
alone.

If the iOS upload succeeded but App Review submission failed, run `release-mobile`
with `ios_build_id` set to that finished EAS build's ID and the release notes.
This retries only App Review: it skips both Android jobs, the iOS build, and the
upload. The workflow verifies that the reused build belongs to this app and was
built with the production iOS profile. Review failures include Apple's associated
validation errors so missing metadata can be corrected before retrying.

## Google Play

Run `release-google-play` from `main` for an Android-only store release, or
`release-mobile` for both stores. The production EAS profile increments the
Android version code automatically and retains the production update channel
and managed upload key. The workflow checks native dependency compatibility,
builds an AAB, and requires its R8 report to show at least 25% optimization,
obfuscation, and shrinking, with a crash deobfuscation mapping included.

Configure a Google service account with access to publish this app in Play
Console, then assign its key under Android submissions in `eas credentials`.
EAS stores the key; do not commit it or add it to `eas.json`. The workflow uses
the existing `EXPO_TOKEN` secret to build and submit non-interactively. The
`GOOGLE_SERVICES_JSON` production file variable is also required for push.

The submit profile targets production with a completed rollout and sends the
changes for review. Submission success means Google accepted the upload, not
that it approved or published the app. Check Publishing overview and Production
in Play Console after submission, and inspect the new bundle's optimization
scores once processed. Managed publishing can delay release after approval.

## Android APK

Android users can install [Rakazo from Google Play](https://play.google.com/store/apps/details?id=com.rakazo.app).
For manual installation, a deployment can offer a signed APK to its own
signed-in accounts; see
[Offer the build in the app](#offer-the-build-in-the-app).

`release-mobile` builds one through the `release-android-apk` workflow, and the
`release-android-apk-selfbuilt` workflow builds one without Expo. Both deliver
it over SSH to the deployment's `MOBILE_APP_ANDROID_FILE` when the
`MOBILE_APK_SSH_*` secrets are set; neither publishes a public GitHub release.
The APK uses the production update channel, so JavaScript changes reach it
through the over-the-air updates below without a new APK. A Google Play install
is signed with Play's key, so switching from the APK to Play means uninstalling
the APK first.

### Building your own APK without Expo

A fork without an Expo account can build the APK entirely on a GitHub-hosted
runner. The `release-android-apk-selfbuilt` workflow needs no `EXPO_TOKEN` or
EAS project: it runs `expo prebuild` for Android, builds the release APK with
Gradle, and, when an SSH target is configured, delivers it to this deployment.
It runs on pushes that touch the mobile app or the packages it bundles, and on
demand from the Actions tab.

Set this repository variable:

- `MOBILE_API_URL`: the HTTPS URL of your Rakazo server. The workflow skips
  with a notice when it is unset. The URL is compiled into the app at build
  time.

Optional repository variables and secrets:

- `MOBILE_ANDROID_PACKAGE`: the Android application ID, for example
  `com.example.rakazo`. Use it to install the APK beside a Play build; the
  committed default is `com.rakazo.app`.
- `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
  `ANDROID_KEY_PASSWORD`: a release signing key, with the keystore file
  base64-encoded. Set all four or none. Without them the APK is signed with the
  template's debug keystore and the workflow prints a warning; it can then
  update only another debug-signed install.
- `MOBILE_APK_SSH_HOST`, `MOBILE_APK_SSH_PORT`, `MOBILE_APK_SSH_USER`,
  `MOBILE_APK_SSH_PRIVATE_KEY`, `MOBILE_APK_SSH_KNOWN_HOSTS`: where the job
  delivers the signed APK. It runs `ssh host "sha256 <digest>" < app.apk`, so
  the account's forced command receives the APK on stdin, verifies the digest
  from `SSH_ORIGINAL_COMMAND`, checks the `PK` header and a size cap, and
  installs it atomically at the configured `MOBILE_APP_ANDROID_FILE`. Without
  these secrets the job builds the APK and stops with a notice: it no longer
  publishes a public release asset.
  Keep the SSH key restricted: a dedicated key whose `authorized_keys` entry
  uses `restrict,command="<receiver>"`, with no pty, agent or port forwarding.

The build disables Expo Updates in the runner's copy of `apps/mobile/app.json`,
so the APK does not receive over-the-air updates from the upstream Expo
project. Install a newer APK to update it. Delivery replaces the server's file,
so the signed-in download link stays the same.

## Offer the build in the app

Settings and the account menu link to the mobile app. A deployment can serve a
signed APK itself, so only signed-in accounts can download it:

```sh
MOBILE_APP_ANDROID_FILE=/srv/rakazo/app.apk
```

When the file is set, the API serves it at
`/api/account/mobile-app/android` and advertises that same-origin path as this
deployment's Android build. A request without a session gets 401; a missing file
gets 404. The API's user must be able to read the file. Replace it atomically
(write a temporary file beside it and rename it) so a download never reads a
partial APK. A stored file takes precedence over `MOBILE_APP_ANDROID_URL` for
Android.

Deployments that host the build elsewhere can keep linking it with https URLs:

```sh
MOBILE_APP_ANDROID_URL=https://example.com/rakazo.apk
MOBILE_APP_IOS_URL=https://example.com/app-store-listing
```

Set these in the deployment's environment beside the other server variables.
Either may be left out, and a platform without one opens the app's store page
instead. Only https URLs are accepted for these; a malformed value fails at
startup rather than hiding the link.

The gated path is same-origin, so the signed-in web session and the desktop
app's own window carry the cookie. Do not publish the same APK as a public
release asset while downloads must require sign-in.

The default Android link is the Google Play listing and the default iOS link is
the App Store listing, so a self-hosted install needs no mobile configuration:
the Rakazo client can select a compatible server from its sign-in screen.

## Android push

For Android push notifications, create a Firebase project and register the app's
Android package. Download `google-services.json` and, from `apps/mobile`, store
it as an EAS file environment variable:

```sh
eas env:set production --name GOOGLE_SERVICES_JSON --type file --value ./google-services.json --visibility secret
```

Keep the file and credentials out of Git. Upload an FCM V1 service account key
with `eas credentials` under Android > Google Service Account > FCM V1. Then
rebuild the APK: Firebase configuration is native, so an OTA update cannot add
it to an existing binary. Builds without the variable remain supported.

## Over-the-air updates

Production and preview builds include `expo-updates` and use the corresponding
EAS Update channel. The runtime version follows the public app version, so bump
`expo.version` whenever native code, config plugins, permissions, or native
dependencies change, then create and submit new store builds.

After the full GitHub Actions test suite passes on `main`, CI publishes a
production OTA update when the revision only changes the mobile JavaScript,
TypeScript, or bundled CSS. CI deliberately skips OTA publishing when native
configuration, modules, dependencies, assets, or the update workflow changed.
The repository needs an `EXPO_TOKEN` Actions secret with access to the linked
Expo project.

To publish a compatible update manually from `apps/mobile`:

```sh
eas update --platform all --channel production --environment production --message "Short description"
```

Installed release builds download a compatible update in the background on
launch and apply it after the next restart. Builds created before
`expo-updates` was configured cannot receive OTA updates and must be replaced
with a new iOS and Android build once.
