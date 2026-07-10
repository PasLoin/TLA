#!/usr/bin/env python3
"""
build_stop_modes.py
====================

Détermine, pour chaque arrêt GTFS, les modes de transport qui le desservent
(bus / tram / métro / train) en croisant les données OpenStreetMap avec les
identifiants stop_id du flux GTFS STIB/MIVB.

Le GTFS ne porte cette information qu'au niveau des lignes (route_type), pas
des arrêts. OSM, en revanche, tague les arrêts physiques (stop_position,
platform, station) avec :
  - un tag ref:STIB_MIVB correspondant directement au stop_id GTFS
  - des tags de mode : bus=yes, tram=yes, subway=yes, train=yes,
    railway=tram_stop, station=subway, etc.

Sortie : data/stop_modes.json
  { "meta": {generated_at, source, source_sha256, counts},
    "modes": { stop_id: ["bus", "tram", ...] } }

Usage:
    python scripts/build_stop_modes.py                    # télécharge le PBF par défaut
    python scripts/build_stop_modes.py --input some.pbf    # test local
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, Set

import osmium
import requests

PBF_URL = (
    "https://raw.githubusercontent.com/PasLoin/Osm-python-analyse_Belgium/"
    "main/pbf_analyse/history/Brussels-daily.pbf"
)

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")
OUT_PATH = os.path.join(DATA_DIR, "stop_modes.json")

# Tags de mode reconnus sur les nœuds/voies public_transport
MODE_TAG_KEYS = ["bus", "tram", "subway", "train", "light_rail", "monorail"]
REF_TAG = "ref:STIB_MIVB"
RELEVANT_PT_VALUES = {"stop_position", "platform", "station"}


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


def modes_from_tags(tags: dict) -> Set[str]:
    modes: Set[str] = set()
    for key in MODE_TAG_KEYS:
        if tags.get(key) == "yes":
            modes.add(key)
    railway = tags.get("railway")
    if railway == "tram_stop":
        modes.add("tram")
    station = tags.get("station")
    if station:
        modes.add(station)  # station=subway -> "subway"
    return modes


class StopModeExtractor(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.stop_modes: Dict[str, Set[str]] = defaultdict(set)
        self.n_pt_entities = 0
        self.n_with_ref = 0

    def _handle(self, tags: dict) -> None:
        pt = tags.get("public_transport")
        if pt not in RELEVANT_PT_VALUES:
            return
        self.n_pt_entities += 1
        ref = tags.get(REF_TAG)
        if not ref:
            return
        self.n_with_ref += 1
        modes = modes_from_tags(tags)
        if not modes:
            return
        for stop_id in (part.strip() for part in ref.split(";")):
            if stop_id:
                self.stop_modes[stop_id] |= modes

    def node(self, n) -> None:
        self._handle(dict(n.tags))

    def way(self, w) -> None:
        self._handle(dict(w.tags))


def download(url: str) -> bytes:
    log(f"Téléchargement : {url}")
    resp = requests.get(url, timeout=180)
    resp.raise_for_status()
    return resp.content


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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
        tmp_path = os.path.join(DATA_DIR, ".stop_modes_download.pbf")
        with open(tmp_path, "wb") as f:
            f.write(pbf_bytes)
        cleanup = True

    try:
        log("Extraction des tags public_transport / modes depuis le PBF")
        handler = StopModeExtractor()
        handler.apply_file(tmp_path)
    finally:
        if cleanup and os.path.exists(tmp_path):
            os.remove(tmp_path)

    modes_out = {sid: sorted(modes) for sid, modes in handler.stop_modes.items()}

    result = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": source,
            "source_sha256": sha256_hex(pbf_bytes),
            "counts": {
                "public_transport_entities": handler.n_pt_entities,
                "entities_with_stib_ref": handler.n_with_ref,
                "resolved_stops": len(modes_out),
            },
        },
        "modes": modes_out,
    }

    log(
        f"  entités public_transport : {handler.n_pt_entities} | "
        f"avec {REF_TAG} : {handler.n_with_ref} | arrêts résolus : {len(modes_out)}"
    )

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_PATH) / 1024
    log(f"  écrit stop_modes.json ({size_kb:.1f} Ko)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
