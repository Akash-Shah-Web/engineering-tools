#!/usr/bin/env bash
# Rebuild viewer/vendor/three.bundle.min.js from npm (three@0.160.0, MIT).
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
cd "$TMP"
npm init -y >/dev/null
npm install --silent three@0.160.0 esbuild@0.20.2
cat > entry.js <<'JS'
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
window.THREE = THREE;
window.THREE_OrbitControls = OrbitControls;
JS
npx esbuild entry.js --bundle --minify --format=iife --outfile="$HERE/viewer/vendor/three.bundle.min.js"
cp node_modules/three/LICENSE "$HERE/viewer/vendor/three.LICENSE"
rm -rf "$TMP"
