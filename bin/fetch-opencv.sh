#!/usr/bin/env bash
# Vendors the official single-file OpenCV.js build (WASM embedded,
# single-threaded). Committed to git; rerun only to change versions.
set -euo pipefail
version="4.13.0"
out="$(dirname "$0")/../public/vendor/opencv-${version}.js"
mkdir -p "$(dirname "$out")"
curl -fL "https://docs.opencv.org/${version}/opencv.js" -o "$out"
shasum -a 256 "$out"
echo "vendored $out"
