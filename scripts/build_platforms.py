#!/usr/bin/env python3
"""
build_platforms.py
===================

Extrait la géométrie des quais/plateformes STIB/MIVB depuis OpenStreetMap
(ways tagués public_transport=platform, reliés aux arrêts GTFS via
ref:STIB_MIVB) pour les dessiner sur la carte — contrairement aux stop_id
GTFS qui ne sont que des points, ça donne la forme réelle du quai.

Sortie : data/platforms.json
  { "meta": {generated_at, source, source_sha256, counts},
    "platforms": [
      { "stop_ids": ["8371", "8372"], "modes": ["subway"], "closed": true,
        "coords": [[lon, lat], ...] },
      ...
    ] }

Usage:
    python scripts/build_platforms.py
    python scripts/build_platforms.py --input some.pbf
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import datetime, timezone
from typing import List

import osmium
import requests

from build_stop_modes import PBF_URL, REF_TAG, modes_from_tags, download, sha256_hex, log

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")
OUT_PATH = os.path.join(DATA_DIR, "platforms.json")

COORD_DECIMALS = 5


class PlatformExtractor(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.platforms: List[dict] = []
        self.n_platform_ways = 0

    def way(self, w) -> None:
        tags = dict(w.tags)
        if tags.get("public_transport") != "platform":
            return
        self.n_platform_ways += 1
        ref = tags.get(REF_TAG)
        if not ref:
            return
        coords = [
            (round(nd.location.lon, COORD_DECIMALS), round(nd.location.lat, COORD_DECIMALS))
            for nd in w.nodes
            if nd.location.valid()
        ]
        if len(coords) < 2:
            return
        stop_ids = sorted({part.strip() for part in ref.split(";") if part.strip()})
        modes = sorted(modes_from_tags(tags))
        self.platforms.append({
            "stop_ids": stop_ids,
            "modes": modes,
            "closed": w.is_closed(),
            "coords": [list(c) for c in coords],
        })


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=PBF_URL, help="URL du fichier .osm.pbf")
    parser.add_argument("--input", help="Chemin local vers un .osm.pbf (évite le téléchargement)")
    args = parser.parse_args()

    if args.input:
        with open(args.input, "rb") as f:
            pbf_bytes = f.read()
        source = f"local:{args.input}"
        tmp_path = args.input
        cleanup = False
    else:
        pbf_bytes = download(args.url)
        source = args.url
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp_path = os.path.join(DATA_DIR, ".platforms_download.pbf")
        with open(tmp_path, "wb") as f:
            f.write(pbf_bytes)
        cleanup = True

    try:
        log("Extraction des géométries de plateformes depuis le PBF")
        handler = PlatformExtractor()
        handler.apply_file(tmp_path, locations=True)
    finally:
        if cleanup and os.path.exists(tmp_path):
            os.remove(tmp_path)

    result = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": source,
            "source_sha256": sha256_hex(pbf_bytes),
            "counts": {
                "platform_ways": handler.n_platform_ways,
                "platforms_with_stib_ref": len(handler.platforms),
            },
        },
        "platforms": handler.platforms,
    }

    log(
        f"  ways public_transport=platform : {handler.n_platform_ways} | "
        f"avec {REF_TAG} et géométrie exploitable : {len(handler.platforms)}"
    )

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_PATH) / 1024
    log(f"  écrit platforms.json ({size_kb:.1f} Ko)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
