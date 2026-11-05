#!/usr/bin/env bash
# Reproducible fetch of the public datasets used to validate CANProof.
#
#   bash data/fetch.sh            # download, then verify against data/checksums.sha256
#   bash data/fetch.sh --record   # first run only: record SHA-256 of what was downloaded
#
# Raw data goes to data/raw/ (git-ignored). Nothing here is committed.
#
# STATUS (2026-11-05): these downloads could NOT be performed in the build
# environment (egress to the hosts below was denied). The URLs are the
# documented public locations as best known; checksums have therefore NOT been
# recorded by the author. Run with --record once, review, and commit
# data/checksums.sha256 so later runs are verified.
set -euo pipefail
cd "$(dirname "$0")"
RAW=raw
mkdir -p "$RAW"

# ROAD: Real ORNL Automotive Dynamometer CAN dataset (Verma et al.)
# Landing page: https://0xsam.com/road/   Paper: https://arxiv.org/abs/2012.14600
ROAD_URL="${ROAD_URL:-https://road.nyc3.digitaloceanspaces.com/road.zip}"

fetch() { # url dest
  if [ -s "$2" ]; then echo "have $2"; return; fi
  echo "fetching $1"
  curl -fL --retry 3 -o "$2.part" "$1" && mv "$2.part" "$2"
}

fetch "$ROAD_URL" "$RAW/road.zip" || { echo "ROAD download failed (see data/README.md)"; }

# CAN-Modes (IEEE DataPort, https://ieee-dataport.org/node/14446) requires an
# IEEE account login, so it cannot be scripted. Download manually and place the
# archive at data/raw/can-modes.zip, then re-run this script to verify it.
[ -s "$RAW/can-modes.zip" ] || echo "CAN-Modes: manual download required -> data/raw/can-modes.zip"

if [ "${1:-}" = "--record" ]; then
  (cd "$RAW" && sha256sum ./*.zip) > checksums.sha256
  echo "recorded checksums.sha256 — review and commit it"
elif [ -s checksums.sha256 ]; then
  (cd "$RAW" && sha256sum -c ../checksums.sha256)
else
  echo "WARNING: no checksums recorded yet; run with --record after a trusted download"
fi

# Extract ONLY ambient (attack-free) captures from ROAD.
if [ -s "$RAW/road.zip" ]; then
  mkdir -p "$RAW/road"
  unzip -o -q "$RAW/road.zip" '*ambient*' -d "$RAW/road" || true
  find "$RAW/road" -name '*ambient*.log' | sort
fi
