#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f native/ArcoVault ] || [ native/ArcoVault.swift -nt native/ArcoVault ] || [ scripts/build-native.sh -nt native/ArcoVault ]; then
  swiftc native/ArcoVault.swift -target arm64-apple-macos15.4 -o native/ArcoVault -O -framework LocalAuthentication
  codesign --force --sign - native/ArcoVault
fi
if [ ! -f native/ArcoTranslate ] || [ native/ArcoTranslate.swift -nt native/ArcoTranslate ] || [ scripts/build-native.sh -nt native/ArcoTranslate ]; then
  swiftc -parse-as-library native/ArcoTranslate.swift -target arm64-apple-macos15.4 -o native/ArcoTranslate -O -framework Translation -framework SwiftUI -framework NaturalLanguage -framework AppKit
  codesign --force --sign - native/ArcoTranslate
fi
if [ ! -f build/icon.icns ] || [ scripts/make-icon.swift -nt build/icon.icns ]; then
  swift scripts/make-icon.swift
fi
