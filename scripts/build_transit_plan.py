#!/usr/bin/env python3
import argparse
import gzip
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import mapbox_vector_tile
from pmtiles.tile import Compression, TileType, zxy_to_tileid
from pmtiles.writer import Writer
from shapely.geometry import mapping, shape

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT_DIR / "data"
PLAN_DIR = DATA_DIR / "plan"

ROUTE_TYPES = {"tram": 0, "metro": 1, "subway": 1, "rail": 2, "bus": 3}

SETTINGS = {
    "route_types": [1, 0],
    "prune_ratio": 0.05,
    "aggregation_distance": 50,
    "min_zoom": 10,
    "max_zoom": 17,
    "station_width": 1.5,
    "bands": [
        {"from": 10, "line_width": 12, "line_spacing": 4, "outline_width": 4},
        {"from": 12, "line_width": 20, "line_spacing": 6, "outline_width": 6},
        {"from": 14, "line_width": 30, "line_spacing": 8, "outline_width": 8},
    ],
    "default": "octilinear",
    "variants": {
        "octilinear": {"label": "Octilinéaire", "layout": "octilinear",
                       "vehicles": False, "veil": 0.88},
        "geo-octilinear": {"label": "Géo-octilinéaire", "layout": "octilinear", "geo_pen": 1,
                           "vehicles": False, "veil": 0.88},
        "orthoradial": {"label": "Orthoradial", "layout": "orthoradial",
                        "vehicles": False, "veil": 0.88},
        "geographic": {"label": "Géographique", "layout": "geographic",
                       "vehicles": True, "veil": 0.45},
    },
}

TILE_EXTENT = 1024
TILE_PX = 256

LAYERS = {
    "inner-connections": {"class": "String", "color": "String", "line": "String",
                          "line-color": "String", "lineCap": "String", "width": "String"},
    "lines": {"class": "String", "color": "String", "line": "String",
              "line-color": "String", "lineCap": "String", "width": "String"},
    "stations": {"color": "String", "fillColor": "String", "stationId": "String",
                 "stationLabel": "String", "width": "String"},
}

LOWER_WORDS = {"de", "du", "des", "la", "le", "les", "l", "d", "au", "aux", "en", "sur",
               "van", "den", "der", "het", "ter", "te", "op", "et"}


def log(*args):
    print(*args, flush=True)


def load(name):
    with open(DATA_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def pretty_name(raw):
    words = re.split(r"(\s+|-|'|’|/|\()", raw.strip().lower())
    out = []
    first = True
    for w in words:
        if not w or re.fullmatch(r"\s+|-|'|’|/|\(", w):
            out.append(w)
            continue
        if not first and w in LOWER_WORDS:
            out.append(w)
        else:
            out.append(w[:1].upper() + w[1:])
        first = False
    return "".join(out)


def station_key(name):
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def cut_shape(points, d0, d1):
    if d1 < d0:
        d0, d1 = d1, d0
    coords = []

    def at(d):
        lo, hi = 0, len(points) - 1
        if d <= points[0][0]:
            return points[0][1], points[0][2]
        if d >= points[-1][0]:
            return points[-1][1], points[-1][2]
        while hi - lo > 1:
            mid = (lo + hi) // 2
            if points[mid][0] <= d:
                lo = mid
            else:
                hi = mid
        a, b = points[lo], points[hi]
        t = 0 if b[0] == a[0] else (d - a[0]) / (b[0] - a[0])
        return a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t

    coords.append(list(at(d0)))
    for p in points:
        if d0 < p[0] < d1:
            coords.append([p[1], p[2]])
    coords.append(list(at(d1)))
    return coords


def build_graph(route_types, prune_ratio):
    routes = load("routes.json")
    stops = load("stops.json")
    shapes = load("shapes.json")
    sequences = load("stop_sequences.json")
    trips = load("trips.json")

    wanted = {rid for rid, r in routes.items() if int(r.get("type", -1)) in route_types}
    patterns = Counter()
    samples = {}
    for t in trips:
        route_id, shape_id, stops_t = t[1], t[3], t[6]
        seq_idx = t[7] if len(t) > 7 else None
        if route_id not in wanted or seq_idx is None or seq_idx >= len(sequences):
            continue
        key = (route_id, shape_id, seq_idx)
        patterns[key] += 1
        if key not in samples:
            samples[key] = stops_t

    best = defaultdict(int)
    for (route_id, _, _), n in patterns.items():
        best[route_id] = max(best[route_id], n)

    lines = {}
    for rid in wanted:
        r = routes[rid]
        lines[rid] = {"id": rid, "label": str(r.get("short_name") or rid),
                      "color": (r.get("color") or "777777").lower()}

    def line_order(rid):
        label = lines[rid]["label"]
        digits = "".join(ch for ch in label if ch.isdigit())
        return (-int(routes[rid].get("type", 0)), int(digits) if digits else 10**6, label)

    node_pos = {}
    edges = {}
    kept = 0
    for (route_id, shape_id, seq_idx), n in patterns.items():
        if n < prune_ratio * best[route_id]:
            continue
        kept += 1
        seq = sequences[seq_idx]
        st = samples[(route_id, shape_id, seq_idx)]
        pts = shapes.get(shape_id) if shape_id else None
        for i in range(len(seq) - 1):
            a, b = seq[i], seq[i + 1]
            if a == b or a not in stops or b not in stops:
                continue
            if pts and len(st[i]) == 3:
                geom = cut_shape(pts, st[i][2], st[i + 1][2])
                if st[i + 1][2] < st[i][2]:
                    geom.reverse()
            else:
                geom = [[stops[a]["lon"], stops[a]["lat"]], [stops[b]["lon"], stops[b]["lat"]]]
            if len(geom) < 2:
                continue
            node_pos.setdefault(a, geom[0])
            node_pos.setdefault(b, geom[-1])
            key = (a, b) if a < b else (b, a)
            entry = edges.get(key)
            if entry is None:
                if key[0] != a:
                    geom = list(reversed(geom))
                edges[key] = {"geom": geom, "lines": {route_id}}
            else:
                entry["lines"].add(route_id)

    features = []
    for sid, pos in sorted(node_pos.items()):
        name = pretty_name(stops[sid]["name"])
        features.append({"type": "Feature",
                         "geometry": {"type": "Point", "coordinates": pos},
                         "properties": {"id": sid, "station_id": station_key(name),
                                        "station_label": name}})
    for (a, b), e in edges.items():
        geom = e["geom"]
        geom[0] = node_pos[a]
        geom[-1] = node_pos[b]
        features.append({"type": "Feature",
                         "geometry": {"type": "LineString", "coordinates": geom},
                         "properties": {"from": a, "to": b,
                                        "lines": [lines[r] for r in sorted(e["lines"], key=line_order)]}})
    used = {r for e in edges.values() for r in e["lines"]}
    log(f"  graphe : {len(used)} lignes, {kept} parcours, {len(edges)} tronçons, {len(node_pos)} arrêts")
    return json.dumps({"type": "FeatureCollection", "features": features},
                      ensure_ascii=False).encode("utf-8")


def tool(loom_bin, name):
    if loom_bin:
        path = Path(loom_bin) / name
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    found = shutil.which(name)
    if not found:
        raise FileNotFoundError(name)
    return found


def run(cmd, stdin, stdout=subprocess.PIPE):
    proc = subprocess.run(cmd, input=stdin, stdout=stdout, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        tail = proc.stderr.decode("utf-8", "replace").strip().splitlines()[-5:]
        raise RuntimeError(f"{Path(cmd[0]).name} a échoué :\n  " + "\n  ".join(tail))
    return proc.stdout


def layout_graph(bins, ordered, variant):
    layout = str(variant.get("layout", "octilinear"))
    if layout == "geographic":
        return ordered
    return run([bins["octi"], "-b", layout, "--geo-pen", str(variant.get("geo_pen", 0)),
                "--retry-on-error"], ordered)


def band_ranges(s):
    bands = sorted(s["bands"], key=lambda b: b["from"])
    out = []
    for i, band in enumerate(bands):
        lo = max(int(band["from"]), int(s["min_zoom"]))
        hi = (int(bands[i + 1]["from"]) - 1) if i + 1 < len(bands) else int(s["max_zoom"])
        hi = min(hi, int(s["max_zoom"]))
        if lo <= hi:
            out.append((lo, hi, band))
    return out


def render_tiles(s, bins, graph, out_dir):
    for lo, hi, band in band_ranges(s):
        run([bins["transitmap"], "--render-engine=mvt", "-z", f"{lo}-{hi}",
             "--line-width", str(band["line_width"]),
             "--line-spacing", str(band["line_spacing"]),
             "--outline-width", str(band["outline_width"]),
             "--tight-stations",
             "--mvt-path", str(out_dir)], graph, stdout=subprocess.DEVNULL)


def shrink_by_zoom(s):
    out = {}
    for lo, hi, band in band_ranges(s):
        lw = band["line_width"] / 10
        ow = band["outline_width"] / 10
        sp = band["line_spacing"] / 10
        hull = lw + (2 * ow + sp) * 0.8
        target = lw * float(s["station_width"]) / 2
        for z in range(lo, hi + 1):
            out[z] = max(hull - target, 0) * TILE_EXTENT / TILE_PX
    return out


def read_varint(buf, pos):
    result = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, pos
        shift += 7


def write_varint(value):
    out = bytearray()
    while True:
        b = value & 0x7F
        value >>= 7
        if value:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def split_layers(data):
    layers = []
    pos = 0
    while pos < len(data):
        key, pos = read_varint(data, pos)
        if key & 7 != 2:
            raise ValueError("tuile MVT inattendue")
        size, pos = read_varint(data, pos)
        body = data[pos:pos + size]
        pos += size
        name = ""
        p = 0
        while p < len(body):
            k, p = read_varint(body, p)
            if k & 7 == 2:
                n, p = read_varint(body, p)
                if k >> 3 == 1:
                    name = body[p:p + n].decode("utf-8")
                    break
                p += n
            elif k & 7 == 0:
                _, p = read_varint(body, p)
            else:
                break
        layers.append((name, write_varint(key) + write_varint(size) + body))
    return layers


def thin_stations(data, shrink):
    if shrink <= 0:
        return data
    layers = split_layers(data)
    if not any(name == "stations" for name, _ in layers):
        return data
    out = bytearray()
    for name, raw in layers:
        if name != "stations":
            out += raw
            continue
        decoded = mapbox_vector_tile.decode(raw, default_options={"y_coord_down": True})
        features = []
        for f in decoded["stations"]["features"]:
            geom = shape(f["geometry"])
            thin = geom.buffer(-shrink, join_style=1)
            if thin.is_empty or thin.area < 1:
                thin = geom.buffer(-shrink / 2, join_style=1)
            if thin.is_empty:
                thin = geom
            features.append({"geometry": mapping(thin), "properties": f["properties"]})
        if features:
            out += mapbox_vector_tile.encode(
                [{"name": "stations", "features": features}],
                default_options={"extents": TILE_EXTENT, "y_coord_down": True})
    return bytes(out)


def tile_lon(x, z):
    return x / (1 << z) * 360.0 - 180.0


def tile_lat(y, z):
    return math.degrees(math.atan(math.sinh(math.pi - 2.0 * math.pi * y / (1 << z))))


def pack(tile_dir, output, name, shrink):
    tiles = []
    for path in Path(tile_dir).glob("*/*/*.mvt"):
        data = path.read_bytes()
        if data:
            z, x, y = int(path.parts[-3]), int(path.parts[-2]), int(path.stem)
            tiles.append((zxy_to_tileid(z, x, y), z, x, y, thin_stations(data, shrink.get(z, 0))))
    if not tiles:
        raise RuntimeError(f"aucune tuile produite dans {tile_dir}")
    tiles.sort()
    zooms = sorted({t[1] for t in tiles})
    top = [t for t in tiles if t[1] == zooms[-1]]
    w = tile_lon(min(t[2] for t in top), zooms[-1])
    e = tile_lon(max(t[2] for t in top) + 1, zooms[-1])
    n = tile_lat(min(t[3] for t in top), zooms[-1])
    s = tile_lat(max(t[3] for t in top) + 1, zooms[-1])
    tmp = Path(str(output) + ".tmp")
    with open(tmp, "wb") as f:
        writer = Writer(f)
        for tile_id, _, _, _, data in tiles:
            writer.write_tile(tile_id, gzip.compress(data, mtime=0))
        writer.finalize(
            {"tile_type": TileType.MVT, "tile_compression": Compression.GZIP,
             "min_zoom": zooms[0], "max_zoom": zooms[-1],
             "min_lon_e7": int(w * 1e7), "min_lat_e7": int(s * 1e7),
             "max_lon_e7": int(e * 1e7), "max_lat_e7": int(n * 1e7),
             "center_zoom": zooms[0] + 3,
             "center_lon_e7": int((w + e) / 2 * 1e7), "center_lat_e7": int((s + n) / 2 * 1e7)},
            {"name": name, "format": "pbf",
             "attribution": "Données GTFS © STIB-MIVB · LOOM (Universität Freiburg)",
             "vector_layers": [{"id": k, "fields": v, "minzoom": zooms[0], "maxzoom": zooms[-1]}
                               for k, v in LAYERS.items()]},
        )
    tmp.replace(output)
    return len(tiles), zooms, [round(w, 5), round(s, 5), round(e, 5), round(n, 5)]


def parse_route_types(value):
    out = []
    for part in value.split(","):
        part = part.strip().lower()
        if not part:
            continue
        out.append(ROUTE_TYPES[part] if part in ROUTE_TYPES else int(part))
    return out


def main():
    p = argparse.ArgumentParser(description="Plan schématique STIB (loom) à partir de data/*.json")
    p.add_argument("--loom-bin", default=os.environ.get("LOOM_BIN", ""))
    p.add_argument("--routes", default=None, help="types de lignes : metro,tram,bus ou codes GTFS")
    p.add_argument("--only", default=None, help="variantes à régénérer, séparées par des virgules")
    p.add_argument("--keep-graph", default=None, help="écrit aussi le graphe d'entrée loom")
    args = p.parse_args()

    s = json.loads(json.dumps(SETTINGS))
    if args.routes:
        s["route_types"] = parse_route_types(args.routes)

    try:
        bins = {n: tool(args.loom_bin, n) for n in ("topo", "loom", "octi", "transitmap")}
    except FileNotFoundError as missing:
        log(f"  ⚠  {missing} introuvable (LOOM_BIN ou PATH), plan non régénéré")
        return 2

    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    graph = build_graph(set(s["route_types"]), float(s["prune_ratio"]))
    if args.keep_graph:
        Path(args.keep_graph).write_bytes(graph)
    try:
        topo = run([bins["topo"], "-d", str(s["aggregation_distance"])], graph)
        ordered = run([bins["loom"]], topo)
    except RuntimeError as err:
        log(f"  ⚠  {err}")
        return 1

    variants = s["variants"]
    selected = set(args.only.split(",")) if args.only else set(variants)
    shrink = shrink_by_zoom(s)
    manifest_path = PLAN_DIR / "plan.json"
    previous = {}
    if manifest_path.exists():
        try:
            previous = {v["id"]: v for v in json.loads(manifest_path.read_text()).get("variants", [])}
        except (ValueError, KeyError):
            previous = {}

    entries = []
    failures = 0
    for vid, variant in variants.items():
        output = PLAN_DIR / f"{vid}.pmtiles"
        entry = {"id": vid, "label": variant["label"], "url": f"plan/{vid}.pmtiles",
                 "vehicles": bool(variant.get("vehicles")),
                 "veil": float(variant.get("veil", 0.85))}
        if vid not in selected:
            if output.exists():
                entries.append({**previous.get(vid, {}), **entry})
            continue
        try:
            laid_out = layout_graph(bins, ordered, variant)
            with tempfile.TemporaryDirectory(prefix="stib_plan_") as tmp:
                render_tiles(s, bins, laid_out, tmp)
                count, zooms, bounds = pack(tmp, output, f"stib-plan-{vid}", shrink)
        except RuntimeError as err:
            failures += 1
            log(f"  ⚠  {vid} : {err}")
            if output.exists():
                entries.append({**previous.get(vid, {}), **entry})
            continue
        size = output.stat().st_size / 1024
        log(f"  {vid} : {count} tuiles z{zooms[0]}-{zooms[-1]} -> {output.relative_to(ROOT_DIR)} ({size:.0f} ko)")
        entries.append({**entry, "min_zoom": zooms[0], "max_zoom": zooms[-1], "bounds": bounds})

    if not entries:
        log("  ⚠  aucune variante disponible, plan.json non écrit")
        return 1
    ids = [e["id"] for e in entries]
    meta = {}
    meta_path = DATA_DIR / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
    manifest = {
        "generated_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "feed_version": meta.get("feed_version"),
        "route_types": s["route_types"],
        "default": s["default"] if s["default"] in ids else ids[0],
        "variants": entries,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    log(f"  plan.json : {len(entries)} variante(s), défaut {manifest['default']}")
    return 1 if failures == len(selected) else 0


if __name__ == "__main__":
    sys.exit(main())
