#!/usr/bin/env bash
set -euo pipefail

surface="${1:-iphone}"
project="apps/pathway-ios/Pathway.xcodeproj"
result_root="${RUNNER_TEMP:-$PWD/.pathway/build}/native-ci-$surface"
mkdir -p "$result_root"

if [[ "$surface" == "visionos" ]]; then
  xcodebuild -project "$project" -scheme Pathway -configuration Debug \
    -sdk xrsimulator -destination 'generic/platform=visionOS Simulator' \
    -derivedDataPath "$result_root/DerivedData" CODE_SIGNING_ALLOWED=NO ARCHS=arm64 build
  exit
fi

# Select an installed device rather than relying on a model name that changes with Xcode.
export PATHWAY_CI_DEVICE_FAMILY="$surface"
device_id="$(xcrun simctl list devices available -j | python3 -c '
import json, os, sys
family = "iPad" if os.environ["PATHWAY_CI_DEVICE_FAMILY"] == "ipad" else "iPhone"
for runtime, devices in sorted(json.load(sys.stdin)["devices"].items(), reverse=True):
    if ".iOS-" not in runtime:
        continue
    candidates = sorted((d for d in devices if d["name"].startswith(family)), key=lambda d: d["name"])
    if candidates:
        print(candidates[0]["udid"])
        break
else:
    raise SystemExit("No installed " + family + " simulator")
')"
xcodebuild -project "$project" -scheme Pathway -configuration Debug \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath "$result_root/DerivedData" -resultBundlePath "$result_root/Tests.xcresult" \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- ARCHS=arm64 test
