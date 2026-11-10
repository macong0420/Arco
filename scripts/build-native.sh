#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ ! -f native/ArcoVault ] || [ native/ArcoVault.swift -nt native/ArcoVault ] || [ scripts/build-native.sh -nt native/ArcoVault ]; then
  swiftc native/ArcoVault.swift -target arm64-apple-macos15.4 -o native/ArcoVault -O -framework LocalAuthentication
  codesign --force --sign - native/ArcoVault
fi
if [ ! -f build/icon.icns ] || [ scripts/make-icon.swift -nt build/icon.icns ]; then
  swift scripts/make-icon.swift
fi
