#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Local ad-hoc signature; distribution requires the owner's Developer ID and notarization.
codesign --force --deep --sign - dist/mac-arm64/Arco.app
codesign --verify --deep --strict dist/mac-arm64/Arco.app
