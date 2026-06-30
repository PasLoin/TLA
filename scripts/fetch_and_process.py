#!/usr/bin/env python3
"""
fetch_and_process.py
=====================

Télécharge le flux GTFS STIB/MIVB, vérifie s'il a changé depuis la dernière
exécution (comparaison de hash SHA-256), et si c'est le cas, le convertit
en un jeu de fichiers JSON compacts utilisés par l'application web
(MapLibre) pour simuler les positions des véhicules en temps réel.

Sortie (dans data/) :
  meta.json            métadonnées (version du flux, dates, compteurs, hash)
  routes.json          { route_id: {short_name, long_name, type, color, text_color} }
  stops.json           { stop_id: {name, lat, lon} }
  shapes.json          { shape_id: [[dist_km, lon, lat], ...] }  (simplifié RDP)
  calendar.json         [ {service_id, days:[L,Ma,Me,J,V,S,D], start_date, end_date} ]
  calendar_dates.json   [ {service_id, date, exception_type} ]
  trips.json            [ [trip_id, route_id, service_id, shape_id|null,
                            direction_id, headsign, stops] ]
                         où stops est:
                           - si shape_id présent : [[arr_sec, dep_sec, dist_km], ...]
                           - si shape_id absent   : [[arr_sec, dep_sec, lon, lat], ...]
                         (arr_sec/dep_sec = arrival_time/departure_time GTFS en
                         secondes ; dep_sec >= arr_sec, leur écart est le temps
                         d'arrêt réel du véhicule à la station)

Convention GTFS pour les horaires après minuit : les valeurs peuvent dépasser
24:00:00 (ex: 25:10:00 = 01:10:00 le lendemain du jour de service). Ces
valeurs sont conservées telles quelles (en secondes, donc pouvant dépasser
86400) ; c'est à l'application cliente de gérer le rattachement au bon jour
calendaire (voir assets/app.js).

Usage:
    python scripts/fetch_and_process.py                 # télécharge depuis GTFS_URL
    python scripts/fetch_and_process.py --input some.zip --force   # test local
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
import sys
import zipfile
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import numpy as np
import requests

GTFS_URL = "https://gtfs.flatturtle.cloud/stib-mivb/_latest/stib-mivb-gtfs.zip"

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")
META_PATH = os.path.join(DATA_DIR, "meta.json")

COORD_DECIMALS = 5           # ~1.1 m de précision, largement suffisant
RDP_EPSILON_DEG = 0.00004    # tolérance de simplification des tracés (~4 m)

WEEKDAY_FIELDS = [
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]


def log(*args) -> None:
    print(*args, file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# Téléchargement / hash
# --------------------------------------------------------------------------

def download(url: str) -> bytes:
    log(f"Téléchargement : {url}")
    resp = requests.get(url, timeout=180)
    resp.raise_for_status()
    return resp.content


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def previous_hash() -> Optional[str]:
    if not os.path.exists(META_PATH):
        return None
    try:
        with open(META_PATH, "r", encoding="utf-8") as f:
            return json.load(f).get("source_sha256")
    except Exception:
        return None


# --------------------------------------------------------------------------
# Lecture CSV depuis le zip GTFS
# --------------------------------------------------------------------------

def read_rows(zf: zipfile.ZipFile, filename: str):
    """Générateur de dict (csv.DictReader) pour un fichier du zip GTFS.
    Renvoie une liste vide si le fichier est absent (certains fichiers GTFS
    sont optionnels)."""
    if filename not in zf.namelist():
        log(f"  (absent du flux : {filename})")
        return
    with zf.open(filename) as raw:
        text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
        reader = csv.DictReader(text)
        for row in reader:
            yield row


def time_to_seconds(value: str) -> Optional[int]:
    """Convertit 'HH:MM:SS' (HH peut dépasser 24) en secondes. None si vide."""
    if not value:
        return None
    value = value.strip()
    if not value:
        return None
    parts = value.split(":")
    if len(parts) != 3:
        return None
    try:
        h, m, s = (int(p) for p in parts)
    except ValueError:
        return None
    return h * 3600 + m * 60 + s


def round_coord(v: float) -> float:
    return round(v, COORD_DECIMALS)


# --------------------------------------------------------------------------
# Simplification de tracés (Ramer-Douglas-Peucker), opère sur (lat, lon)
# mais conserve les distances cumulées (shape_dist_traveled) d'origine.
# --------------------------------------------------------------------------

def _perp_distance(pt, start, end) -> float:
    x, y = pt
    x1, y1 = start
    x2, y2 = end
    if x1 == x2 and y1 == y2:
        return math.hypot(x - x1, y - y1)
    num = abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1)
    den = math.hypot(y2 - y1, x2 - x1)
    return num / den


def rdp_indices(coords: List[Tuple[float, float]], epsilon: float) -> List[int]:
    """Renvoie les indices à conserver (algorithme RDP itératif, pour éviter
    tout risque de récursion profonde sur de longs tracés)."""
    n = len(coords)
    if n < 3:
        return list(range(n))
    keep = [False] * n
    keep[0] = True
    keep[-1] = True
    stack = [(0, n - 1)]
    while stack:
        start_i, end_i = stack.pop()
        start, end = coords[start_i], coords[end_i]
        max_dist = -1.0
        max_idx = -1
        for i in range(start_i + 1, end_i):
            d = _perp_distance(coords[i], start, end)
            if d > max_dist:
                max_dist = d
                max_idx = i
        if max_dist > epsilon and max_idx != -1:
            keep[max_idx] = True
            stack.append((start_i, max_idx))
            stack.append((max_idx, end_i))
    return [i for i, k in enumerate(keep) if k]


# --------------------------------------------------------------------------
# Pipeline principal
# --------------------------------------------------------------------------

def process(zip_bytes: bytes, source_url: str) -> Dict:
    zf = zipfile.ZipFile(io.BytesIO(zip_bytes))

    # ---- agency / feed_info (métadonnées) ----
    agency_name, agency_url = None, None
    for row in read_rows(zf, "agency.txt"):
        agency_name = row.get("agency_name")
        agency_url = row.get("agency_url")
        break

    feed_info = {}
    for row in read_rows(zf, "feed_info.txt"):
        feed_info = row
        break

    # ---- routes ----
    log("Traitement routes.txt")
    routes: Dict[str, Dict] = {}
    for row in read_rows(zf, "routes.txt"):
        routes[row["route_id"]] = {
            "short_name": row.get("route_short_name") or row.get("route_long_name") or "",
            "long_name": row.get("route_long_name") or "",
            "type": int(row["route_type"]),
            "color": (row.get("route_color") or "1d4ed8").strip() or "1d4ed8",
            "text_color": (row.get("route_text_color") or "ffffff").strip() or "ffffff",
        }

    # ---- stops ----
    log("Traitement stops.txt")
    stops: Dict[str, Dict] = {}
    for row in read_rows(zf, "stops.txt"):
        try:
            lat = float(row["stop_lat"])
            lon = float(row["stop_lon"])
        except (KeyError, ValueError):
            continue
        stops[row["stop_id"]] = {
            "name": row.get("stop_name") or "",
            "lat": round_coord(lat),
            "lon": round_coord(lon),
        }

    # ---- calendar ----
    log("Traitement calendar.txt")
    calendar: List[Dict] = []
    for row in read_rows(zf, "calendar.txt"):
        calendar.append({
            "service_id": row["service_id"],
            "days": [int(row[f]) for f in WEEKDAY_FIELDS],
            "start_date": row["start_date"],
            "end_date": row["end_date"],
        })

    # ---- calendar_dates ----
    log("Traitement calendar_dates.txt")
    calendar_dates: List[Dict] = []
    for row in read_rows(zf, "calendar_dates.txt"):
        calendar_dates.append({
            "service_id": row["service_id"],
            "date": row["date"],
            "exception_type": int(row["exception_type"]),
        })

    # ---- shapes (lecture complète, gardée en mémoire pour la projection
    #      des arrêts, puis simplifiée pour l'export) ----
    log("Traitement shapes.txt")
    shapes_raw: Dict[str, List[Tuple[float, float, float]]] = {}
    for row in read_rows(zf, "shapes.txt"):
        sid = row["shape_id"]
        shapes_raw.setdefault(sid, []).append((
            int(row["shape_pt_sequence"]),
            float(row["shape_pt_lat"]),
            float(row["shape_pt_lon"]),
            float(row.get("shape_dist_traveled") or 0.0),
        ))
    shape_arrays: Dict[str, Dict[str, np.ndarray]] = {}
    for sid, pts in shapes_raw.items():
        pts.sort(key=lambda p: p[0])
        lats = np.array([p[1] for p in pts], dtype=np.float64)
        lons = np.array([p[2] for p in pts], dtype=np.float64)
        dists = np.array([p[3] for p in pts], dtype=np.float64)
        # Recalcule shape_dist_traveled si absent du flux (tous nuls)
        if dists.max() == 0.0 and len(pts) > 1:
            cum = [0.0]
            for i in range(1, len(pts)):
                dlat = lats[i] - lats[i - 1]
                dlon = (lons[i] - lons[i - 1]) * math.cos(math.radians(lats[i]))
                step_km = math.hypot(dlat, dlon) * 111.32
                cum.append(cum[-1] + step_km)
            dists = np.array(cum)
        shape_arrays[sid] = {"lat": lats, "lon": lons, "dist": dists}

    # ---- trips (métadonnées) ----
    log("Traitement trips.txt")
    trips_meta: Dict[str, Dict] = {}
    for row in read_rows(zf, "trips.txt"):
        shape_id = (row.get("shape_id") or "").strip() or None
        trips_meta[row["trip_id"]] = {
            "route_id": row["route_id"],
            "service_id": row["service_id"],
            "shape_id": shape_id,
            "direction_id": int(row["direction_id"]) if row.get("direction_id") not in (None, "") else 0,
            "headsign": row.get("trip_headsign") or "",
        }

    # ---- stop_times (regroupés par trip) ----
    # On conserve désormais arrival_time ET departure_time séparément (et non
    # plus une seule valeur fusionnée) afin que le client puisse reproduire le
    # temps d'arrêt (dwell time) réel à chaque station plutôt que de faire
    # glisser le véhicule en continu d'un arrêt à l'autre.
    log("Traitement stop_times.txt (peut prendre un moment)")
    stop_times_by_trip: Dict[str, List[Tuple[int, int, int, str]]] = {}
    for row in read_rows(zf, "stop_times.txt"):
        trip_id = row["trip_id"]
        seq = int(row["stop_sequence"])
        arr_t = time_to_seconds(row.get("arrival_time"))
        dep_t = time_to_seconds(row.get("departure_time"))
        if arr_t is None:
            arr_t = dep_t
        if dep_t is None:
            dep_t = arr_t
        if arr_t is None:
            continue
        if dep_t < arr_t:
            dep_t = arr_t  # garde-fou : un flux mal formé ne doit pas inverser l'ordre
        stop_times_by_trip.setdefault(trip_id, []).append((seq, arr_t, dep_t, row["stop_id"]))

    # ---- projection des arrêts sur les tracés (avec cache + recherche
    #      "vers l'avant" pour rester monotone même sur des lignes en boucle) ----
    log("Projection des arrêts sur les tracés (shapes)")
    nearest_cache: Dict[Tuple[str, int, str], float] = {}

    def project_stop(shape_id: str, start_idx: int, lat: float, lon: float) -> Tuple[float, int]:
        arrs = shape_arrays[shape_id]
        lat0 = math.radians(lat)
        coslat = math.cos(lat0)
        sl_lat = arrs["lat"][start_idx:]
        sl_lon = arrs["lon"][start_idx:]
        dlat = sl_lat - lat
        dlon = (sl_lon - lon) * coslat
        d2 = dlat * dlat + dlon * dlon
        local_idx = int(np.argmin(d2))
        idx = start_idx + local_idx
        return float(arrs["dist"][idx]), idx

    trips_out: List[list] = []
    n_with_shape = 0
    n_fallback = 0
    n_skipped = 0

    # Index { route_short_name: { stop_id: [shape_id, dist_km] } }, construit
    # à partir des projections déjà calculées ci-dessous. Sert à repositionner
    # les données de l'API temps réel VehiclePositions, qui ne fournissent ni
    # lat/lon ni identité de véhicule : juste (lineId, pointId, distanceFromPoint).
    # pointId correspond exactement à un stop_id GTFS ; en réutilisant le même
    # stop_id que celui vu ici, on récupère le tracé (shape) orienté dans le
    # bon sens (un stop_id donné n'est en pratique servi que dans une seule
    # direction chez la STIB), et on ajoute distanceFromPoint à la distance du
    # stop pour estimer la position courante du véhicule sur ce tracé.
    stop_shape_index: Dict[Tuple[str, str], list] = {}

    def index_stop_shape(route_id: str, stop_id: str, shape_id: str, dist: float) -> None:
        short = routes.get(route_id, {}).get("short_name")
        if not short:
            return
        key = (short, stop_id)
        if key not in stop_shape_index:
            stop_shape_index[key] = [shape_id, round(dist, 4)]

    for trip_id, stop_seq_list in stop_times_by_trip.items():
        meta = trips_meta.get(trip_id)
        if meta is None:
            n_skipped += 1
            continue
        stop_seq_list.sort(key=lambda x: x[0])
        shape_id = meta["shape_id"]
        has_shape = shape_id is not None and shape_id in shape_arrays and len(shape_arrays[shape_id]["lat"]) >= 2

        out_stops = []
        if has_shape:
            last_idx = 0
            ok = True
            for _, arr_t, dep_t, stop_id in stop_seq_list:
                st = stops.get(stop_id)
                if st is None:
                    ok = False
                    break
                cache_key = (shape_id, last_idx, stop_id)
                if cache_key in nearest_cache:
                    dist = nearest_cache[cache_key]
                else:
                    dist, idx = project_stop(shape_id, last_idx, st["lat"], st["lon"])
                    nearest_cache[cache_key] = dist
                    last_idx = idx
                out_stops.append([arr_t, dep_t, round(dist, 4)])
                index_stop_shape(meta["route_id"], stop_id, shape_id, dist)
            if ok and out_stops:
                trips_out.append([
                    trip_id, meta["route_id"], meta["service_id"], shape_id,
                    meta["direction_id"], meta["headsign"], out_stops,
                ])
                n_with_shape += 1
                continue
            # si la projection échoue, on retombe sur le mode sans tracé
            out_stops = []

        # mode "sans tracé" : ligne droite entre arrêts successifs
        for _, arr_t, dep_t, stop_id in stop_seq_list:
            st = stops.get(stop_id)
            if st is None:
                continue
            out_stops.append([arr_t, dep_t, st["lon"], st["lat"]])
        if len(out_stops) >= 2:
            trips_out.append([
                trip_id, meta["route_id"], meta["service_id"], None,
                meta["direction_id"], meta["headsign"], out_stops,
            ])
            n_fallback += 1
        else:
            n_skipped += 1

    log(f"  trips avec tracé : {n_with_shape} | sans tracé (fallback) : {n_fallback} | ignorés : {n_skipped}")

    # ---- simplification + export des shapes réellement utilisées ----
    used_shape_ids = {t[3] for t in trips_out if t[3]}
    shapes_out: Dict[str, list] = {}
    for sid in used_shape_ids:
        arrs = shape_arrays[sid]
        coords = list(zip(arrs["lat"].tolist(), arrs["lon"].tolist()))
        keep_idx = rdp_indices(coords, RDP_EPSILON_DEG)
        shapes_out[sid] = [
            [round(float(arrs["dist"][i]), 4), round_coord(float(arrs["lon"][i])), round_coord(float(arrs["lat"][i]))]
            for i in keep_idx
        ]

    # ---- index stop -> (shape, distance) par ligne, pour les données temps réel ----
    stop_shape_index_out: Dict[str, Dict[str, list]] = {}
    for (short, stop_id), val in stop_shape_index.items():
        stop_shape_index_out.setdefault(short, {})[stop_id] = val

    # ---- méta ----
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source_url": source_url,
        "source_sha256": sha256_hex(zip_bytes),
        "agency_name": agency_name,
        "agency_url": agency_url,
        "feed_version": feed_info.get("feed_version"),
        "feed_start_date": feed_info.get("feed_start_date"),
        "feed_end_date": feed_info.get("feed_end_date"),
        "counts": {
            "routes": len(routes),
            "stops": len(stops),
            "shapes": len(shapes_out),
            "trips": len(trips_out),
            "calendar": len(calendar),
            "calendar_dates": len(calendar_dates),
            "stop_shape_index_lines": len(stop_shape_index_out),
        },
    }

    return {
        "meta": meta,
        "routes": routes,
        "stops": stops,
        "shapes": shapes_out,
        "calendar": calendar,
        "calendar_dates": calendar_dates,
        "trips": trips_out,
        "stop_shape_index": stop_shape_index_out,
    }


def write_outputs(result: Dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)

    def dump(name: str, obj) -> None:
        path = os.path.join(DATA_DIR, name)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        size_kb = os.path.getsize(path) / 1024
        log(f"  écrit {name} ({size_kb:.1f} Ko)")

    log("Écriture des fichiers data/")
    dump("meta.json", result["meta"])
    dump("routes.json", result["routes"])
    dump("stops.json", result["stops"])
    dump("shapes.json", result["shapes"])
    dump("calendar.json", result["calendar"])
    dump("calendar_dates.json", result["calendar_dates"])
    dump("trips.json", result["trips"])
    dump("stop_shape_index.json", result["stop_shape_index"])


def set_github_output(key: str, value: str) -> None:
    out_path = os.environ.get("GITHUB_OUTPUT")
    if not out_path:
        return
    with open(out_path, "a", encoding="utf-8") as f:
        f.write(f"{key}={value}\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=GTFS_URL, help="URL du flux GTFS (zip)")
    parser.add_argument("--input", help="Chemin local vers un zip GTFS (évite le téléchargement, pour tester)")
    parser.add_argument("--force", action="store_true", help="Traiter même si le hash source n'a pas changé")
    args = parser.parse_args()

    if args.input:
        with open(args.input, "rb") as f:
            zip_bytes = f.read()
        source_url = f"local:{args.input}"
    else:
        zip_bytes = download(args.url)
        source_url = args.url

    new_hash = sha256_hex(zip_bytes)
    old_hash = previous_hash()
    log(f"Hash précédent : {old_hash}")
    log(f"Hash actuel    : {new_hash}")

    if not args.force and old_hash == new_hash:
        log("Aucun changement détecté — rien à faire.")
        set_github_output("changed", "false")
        return 0

    result = process(zip_bytes, source_url)
    write_outputs(result)
    set_github_output("changed", "true")
    log("Terminé.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
