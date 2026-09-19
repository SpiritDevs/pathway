#!/usr/bin/env bash
set -euo pipefail
umask 077

# Run only in the fleet's dedicated checkout/account, with one job per host.
required=(
  RUNNER_TEMP APPLE_API_KEY APPLE_API_KEY_ID APPLE_API_ISSUER APPLE_TEAM_ID
  IOS_DEVELOPMENT_CERTIFICATE IOS_DEVELOPMENT_CERTIFICATE_PASSWORD
  PATHWAY_CLERK_PUBLISHABLE_KEY PATHWAY_CLERK_JWT_TEMPLATE PATHWAY_CONVEX_URL
  PATHWAY_RELAY_URL PATHWAY_HOSTED_APP_URL
)
for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Missing TestFlight release configuration: $name" >&2
    exit 1
  fi
done

version="${RELEASE_VERSION:-}"
version="${version#v}"
if [[ -n "$version" && ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "The iOS version must have three numeric components, for example 1.0.17." >&2
  exit 1
fi
if [[ "$PATHWAY_CLERK_PUBLISHABLE_KEY" != pk_live_* ]]; then
  echo "TestFlight releases require the production Clerk publishable key." >&2
  exit 1
fi

project="apps/pathway-ios/Pathway.xcodeproj"
result_root="$RUNNER_TEMP/pathway-testflight"
mkdir -p "$result_root"
signing_root="$(mktemp -d "$RUNNER_TEMP/pathway-ios-signing.XXXXXX")"
keychain_path="$signing_root/signing.keychain-db"
key_path="$signing_root/AuthKey.p8"
original_keychains=()
security list-keychains -d user > "$signing_root/keychains.txt"
while IFS= read -r keychain; do
  original_keychains+=("$keychain")
done < <(sed -e 's/^[[:space:]]*"//' -e 's/"$//' "$signing_root/keychains.txt")

# Automatic provisioning can download profiles. Preserve the runner's existing
# profiles and remove only additions made by this job, including on failure.
profile_dirs=(
  "$HOME/Library/MobileDevice/Provisioning Profiles"
  "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
)
python3 - "$signing_root/profiles.json" "${profile_dirs[@]}" <<'PY'
import json, pathlib, sys
paths = [str(path) for directory in sys.argv[2:] for path in pathlib.Path(directory).glob("*.mobileprovision")]
pathlib.Path(sys.argv[1]).write_text(json.dumps(paths))
PY

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  security list-keychains -d user -s "${original_keychains[@]}"
  security delete-keychain "$keychain_path" >/dev/null 2>&1
  python3 - "$signing_root/profiles.json" "${profile_dirs[@]}" <<'PY'
import json, pathlib, sys
original = set(json.loads(pathlib.Path(sys.argv[1]).read_text()))
for directory in sys.argv[2:]:
    for path in pathlib.Path(directory).glob("*.mobileprovision"):
        if str(path) not in original:
            path.unlink()
PY
  rm -rf "$signing_root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '%s' "$APPLE_API_KEY" > "$key_path"
printf '%s' "$IOS_DEVELOPMENT_CERTIFICATE" | base64 -D > "$signing_root/certificate.p12"
keychain_password="$(openssl rand -hex 32)"
security create-keychain -p "$keychain_password" "$keychain_path"
security set-keychain-settings -lut 7200 "$keychain_path"
security unlock-keychain -p "$keychain_password" "$keychain_path"
security import "$signing_root/certificate.p12" -k "$keychain_path" \
  -P "$IOS_DEVELOPMENT_CERTIFICATE_PASSWORD" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -k "$keychain_password" "$keychain_path" >/dev/null
if ! security find-identity -v -p codesigning "$keychain_path" \
  | grep -F 'Apple Development:' | grep -Fq "($APPLE_TEAM_ID)"; then
  echo "The signing certificate must include an Apple Development private key for APPLE_TEAM_ID." >&2
  exit 1
fi
security list-keychains -d user -s "$keychain_path" "${original_keychains[@]}"

node scripts/configure-pathway-ios.ts
xcodebuild -version
node scripts/ios/build-terminal.mjs --check

auth=(
  -allowProvisioningUpdates
  -authenticationKeyPath "$key_path"
  -authenticationKeyID "$APPLE_API_KEY_ID"
  -authenticationKeyIssuerID "$APPLE_API_ISSUER"
)
version_settings=(CODE_SIGN_STYLE=Automatic)
if [[ -n "$version" ]]; then
  # Command-line settings apply to the app and both embedded extensions.
  version_settings+=("MARKETING_VERSION=$version")
fi
xcodebuild -project "$project" -scheme Pathway -configuration Release \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$result_root/DerivedData" \
  -archivePath "$result_root/Pathway.xcarchive" \
  -onlyUsePackageVersionsFromResolvedFile \
  "${auth[@]}" "${version_settings[@]}" \
  "DEVELOPMENT_TEAM=$APPLE_TEAM_ID" \
  'CODE_SIGN_IDENTITY=Apple Development' archive 2>&1 | tee "$result_root/archive.log"

python3 - "$result_root/ExportOptions.plist" <<'PY'
import os, plistlib, sys
with open(sys.argv[1], "wb") as file:
    plistlib.dump({
        "method": "app-store-connect",
        "destination": "upload",
        "signingStyle": "automatic",
        "teamID": os.environ["APPLE_TEAM_ID"],
        "manageAppVersionAndBuildNumber": True,
        "uploadSymbols": True,
    }, file)
PY

# Xcode uses cloud-managed distribution signing and uploads directly to Apple.
xcodebuild -exportArchive -archivePath "$result_root/Pathway.xcarchive" \
  -exportPath "$result_root/export" \
  -exportOptionsPlist "$result_root/ExportOptions.plist" \
  "${auth[@]}" 2>&1 | tee "$result_root/upload.log"

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  archive_version=$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' \
    "$result_root/Pathway.xcarchive/Info.plist")
  {
    echo "Uploaded Pathway iOS $archive_version to App Store Connect for TestFlight."
    echo
    echo "Source commit: $(git rev-parse HEAD)"
    echo
    echo "Xcode manages the uploaded build number. Check TestFlight for the final number and processing status."
    echo "Internal groups with automatic distribution receive the build after Apple finishes processing and any compliance requirements are resolved."
  } >> "$GITHUB_STEP_SUMMARY"
fi
