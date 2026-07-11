#!/usr/bin/env python3
"""
build_footpaths.py
===================

Calcule le temps de correspondance à pied réel entre arrêts proches, en
suivant le réseau piéton OSM (trottoirs, couloirs, escaliers, ascenseurs)
plutôt qu'une simple distance à vol d'oiseau. Le planificateur d'itinéraire
(assets/app.js) utilise aujourd'hui la distance euclidienne pour estimer les
correspondances ; dans une station à plusieurs niveaux (ex: Delacroix,
Louise), ça sous-estime largement le temps réel — cette précalcul comble
l'écart pour les arrêts où le réseau piéton est cartographié.

Principe :
  1. Localise chaque stop_id GTFS sur le graphe piéton OSM (ref:STIB_MIVB
     sur les nœuds stop_position, en repli le centroïde des ways platform).
  2. Construit un graphe piéton à partir des ways highway=footway/path/
     pedestrian/living_street/steps/corridor et des ways platform, restreint
     aux abords des arrêts (ANCHOR_BUFFER_M) pour rester compact.
  3. Applique une vitesse réduite + pénalité fixe sur les escaliers, et une
     pénalité d'attente/trajet sur les nœuds highway=elevator.
  4. Pour chaque arrêt, lance un Dijkstra borné (TIME_CUTOFF_S), garde les
     N arrêts atteignables les plus proches, et reconstruit le chemin en
     segments fusionnés par type ("walk"/"steps"/"elevator") pour permettre
     des instructions ("prenez l'escalier", "ascenseur") côté client.

Sortie : data/footpaths.json
  { "meta": {generated_at, source, source_sha256, counts},
    "footpaths": { stop_id: [
      [other_stop_id, seconds, [[kind, level_pair_or_null, seconds], ...],
        [[lon, lat], ...]],
      ...
    ] } }
  - kind : "walk" | "steps" | "elevator"
  - level_pair : [a, b] issu du tag OSM level="a;b" sur l'escalier/ascenseur
    (niveaux reliés, sans indication fiable de sens de parcours), ou null
  - le dernier élément est la géométrie réelle du chemin (nœuds du graphe
    piéton OSM traversés, simplifiée par RDP comme les tracés de lignes
    dans fetch_and_process.py) — remplace le trait pointillé à vol
    d'oiseau sur la carte quand elle est disponible pour la paire

Usage:
    python scripts/build_footpaths.py
    python scripts/build_footpaths.py --input some.pbf
"""

from __future__ import annotations

import argparse
import heapq
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

import osmium

from build_stop_modes import PBF_URL, REF_TAG, download, sha256_hex, log
from fetch_and_process import rdp_indices

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")
OUT_PATH = os.path.join(DATA_DIR, "footpaths.json")

WALKABLE_HIGHWAYS = {"footway", "path", "pedestrian", "living_street", "steps", "corridor"}

WALK_SPEED_MPS = 1.25    # cohérent avec WALK_SPEED_MPS dans assets/app.js
STEPS_SPEED_MPS = 0.6    # allure réduite dans un escalier
STEPS_PENALTY_S = 8      # pénalité fixe une fois par volée d'escaliers
ELEVATOR_PENALTY_S = 25  # attente + trajet, répartie sur les arêtes incidentes
SNAP_MAX_M = 80          # distance max pour rattacher un arrêt au graphe piéton
ANCHOR_BUFFER_M = 400    # ne garde que les ways proches d'au moins un arrêt
TIME_CUTOFF_S = 420      # horizon de recherche Dijkstra par arrêt (~7 min)
MAX_NEIGHBORS = 8        # nb max de correspondances gardées par arrêt
COORD_DECIMALS = 5       # ~1.1 m de précision, cohérent avec fetch_and_process.py
RDP_EPSILON_DEG = 0.00004  # tolérance de simplification du tracé (~4 m)

GRID_DEG = 0.004  # ~440 m à la latitude de Bruxelles, pour l'index spatial


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def grid_key(lon: float, lat: float) -> Tuple[int, int]:
    return (int(math.floor(lon / GRID_DEG)), int(math.floor(lat / GRID_DEG)))


def parse_level_pair(level_str: str) -> Optional[Tuple[float, float]]:
    """Le tag OSM level="A;B" indique les deux niveaux reliés par un
    escalier/ascenseur (ex: "0;-1"). On ignore les formats plus complexes
    (single value, listes >2) faute de sens univoque pour une instruction."""
    if not level_str:
        return None
    parts = [p.strip() for p in level_str.split(";") if p.strip()]
    if len(parts) != 2:
        return None
    try:
        return (float(parts[0]), float(parts[1]))
    except ValueError:
        return None


class AnchorAndElevatorExtractor(osmium.SimpleHandler):
    """Première passe : localise les arrêts GTFS sur la carte et repère les
    nœuds highway=elevator (quasi tous membres du graphe piéton, cf. analyse
    préalable — cette passe doit donc précéder la construction du graphe)."""

    def __init__(self) -> None:
        super().__init__()
        self.anchor_primary: Dict[str, Tuple[float, float]] = {}
        self.anchor_fallback: Dict[str, List[Tuple[float, float]]] = defaultdict(list)
        self.elevator_ids: set = set()
        self.elevator_levels: Dict[int, Optional[Tuple[float, float]]] = {}

    def node(self, n) -> None:
        tags = dict(n.tags)
        if tags.get("highway") == "elevator":
            self.elevator_ids.add(n.id)
            self.elevator_levels[n.id] = parse_level_pair(tags.get("level", ""))
        if not n.location.valid():
            return
        pt = tags.get("public_transport")
        ref = tags.get(REF_TAG)
        if not ref:
            return
        if pt == "stop_position":
            for sid in (p.strip() for p in ref.split(";")):
                if sid:
                    self.anchor_primary.setdefault(sid, (n.location.lon, n.location.lat))
        elif pt in ("platform", "station"):
            # Repli : beaucoup de plateformes sont cartographiées comme un
            # simple nœud (pas une way) — sans ce cas, elles seraient
            # ignorées faute de stop_position dédiée.
            for sid in (p.strip() for p in ref.split(";")):
                if sid:
                    self.anchor_fallback[sid].append((n.location.lon, n.location.lat))

    def way(self, w) -> None:
        tags = dict(w.tags)
        if tags.get("public_transport") not in ("platform", "station"):
            return
        ref = tags.get(REF_TAG)
        if not ref:
            return
        coords = [(nd.location.lon, nd.location.lat) for nd in w.nodes if nd.location.valid()]
        if not coords:
            return
        cx = sum(c[0] for c in coords) / len(coords)
        cy = sum(c[1] for c in coords) / len(coords)
        for sid in (p.strip() for p in ref.split(";")):
            if sid:
                self.anchor_fallback[sid].append((cx, cy))

    def resolve_anchors(self) -> Dict[str, Tuple[float, float]]:
        anchors: Dict[str, Tuple[float, float]] = dict(self.anchor_primary)
        for sid, pts in self.anchor_fallback.items():
            if sid in anchors:
                continue
            cx = sum(p[0] for p in pts) / len(pts)
            cy = sum(p[1] for p in pts) / len(pts)
            anchors[sid] = (cx, cy)
        return anchors


class SpatialIndex:
    def __init__(self, points: Dict[str, Tuple[float, float]]) -> None:
        self.cells: Dict[Tuple[int, int], List[str]] = defaultdict(list)
        self.points = points
        for key, (lon, lat) in points.items():
            self.cells[grid_key(lon, lat)].append(key)

    def near(self, lon: float, lat: float, radius_m: float) -> List[str]:
        gx, gy = grid_key(lon, lat)
        span = int(math.ceil(radius_m / (GRID_DEG * 111320))) + 1
        out = []
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for key in self.cells.get((gx + dx, gy + dy), ()):
                    plon, plat = self.points[key]
                    if haversine_m(lon, lat, plon, plat) <= radius_m:
                        out.append(key)
        return out


class GraphBuilder(osmium.SimpleHandler):
    """Deuxième passe : construit le graphe piéton restreint aux abords des
    arrêts (ANCHOR_BUFFER_M), avec vitesses/pénalités par type de voie.
    Chaque arête porte, en plus de son poids en secondes, un type
    ("walk"/"steps"/"elevator") et éventuellement une paire de niveaux
    (level="A;B" côté OSM), pour pouvoir reconstruire des instructions
    ("prenez l'escalier", "ascenseur") plutôt qu'un simple temps total."""

    def __init__(self, anchor_index: SpatialIndex, elevator_ids: set, elevator_levels: Dict[int, Optional[Tuple[float, float]]]) -> None:
        super().__init__()
        self.anchor_index = anchor_index
        self.elevator_ids = elevator_ids
        self.elevator_levels = elevator_levels
        # adj[node] = [(neighbor, seconds, kind, level_pair_or_None), ...]
        self.adj: Dict[int, List[Tuple]] = defaultdict(list)
        self.node_coords: Dict[int, Tuple[float, float]] = {}
        self.n_ways_kept = 0

    def _is_near_anchor(self, lon: float, lat: float) -> bool:
        return len(self.anchor_index.near(lon, lat, ANCHOR_BUFFER_M)) > 0

    def _add_edge(self, a, b, seconds: float, kind: str, level: Optional[Tuple[float, float]]) -> None:
        is_elevator = a.ref in self.elevator_ids or b.ref in self.elevator_ids
        if is_elevator:
            seconds += ELEVATOR_PENALTY_S / 2
            kind = "elevator"
            level = self.elevator_levels.get(a.ref) or self.elevator_levels.get(b.ref) or level
        self.adj[a.ref].append((b.ref, seconds, kind, level))
        self.adj[b.ref].append((a.ref, seconds, kind, level))
        self.node_coords[a.ref] = (a.location.lon, a.location.lat)
        self.node_coords[b.ref] = (b.location.lon, b.location.lat)

    def way(self, w) -> None:
        tags = dict(w.tags)
        hw = tags.get("highway")
        is_platform = tags.get("public_transport") == "platform"
        if hw not in WALKABLE_HIGHWAYS and not is_platform:
            return
        nodes = [nd for nd in w.nodes if nd.location.valid()]
        if len(nodes) < 2:
            return
        if not any(self._is_near_anchor(nd.location.lon, nd.location.lat) for nd in nodes):
            return
        self.n_ways_kept += 1
        is_steps = hw == "steps"
        speed = STEPS_SPEED_MPS if is_steps else WALK_SPEED_MPS
        kind = "steps" if is_steps else "walk"
        level = parse_level_pair(tags.get("level", "")) if is_steps else None
        for i in range(len(nodes) - 1):
            a, b = nodes[i], nodes[i + 1]
            d = haversine_m(a.location.lon, a.location.lat, b.location.lon, b.location.lat)
            if d == 0:
                continue
            seconds = d / speed
            if is_steps and i == 0:
                seconds += STEPS_PENALTY_S
            self._add_edge(a, b, seconds, kind, level)


def snap_anchor(lon: float, lat: float, node_index: SpatialIndex) -> Optional[int]:
    candidates = node_index.near(lon, lat, SNAP_MAX_M)
    if not candidates:
        return None
    best = min(candidates, key=lambda nid: haversine_m(lon, lat, *node_index.points[nid]))
    return best


def dijkstra(adj: Dict, source, cutoff_s: float) -> Tuple[Dict, Dict]:
    dist = {source: 0.0}
    prev: Dict = {}  # node -> (parent, kind, level, seconds)
    pq = [(0.0, source)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, math.inf):
            continue
        if d > cutoff_s:
            continue
        for v, w, kind, level in adj.get(u, ()):
            nd = d + w
            if nd <= cutoff_s and nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = (u, kind, level, w)
                heapq.heappush(pq, (nd, v))
    return dist, prev


MIN_SEGMENT_S = 3  # segments plus courts fusionnés/ignorés (bruit du rattachement)


def _coord_of(node, node_coords: Dict[int, Tuple[float, float]], anchors: Dict[str, Tuple[float, float]]) -> List[float]:
    if isinstance(node, str) and node.startswith("stop:"):
        lon, lat = anchors[node[len("stop:"):]]
    else:
        lon, lat = node_coords[node]
    return [round(lon, COORD_DECIMALS), round(lat, COORD_DECIMALS)]


def reconstruct_path(
    prev: Dict, source, dest,
    node_coords: Dict[int, Tuple[float, float]], anchors: Dict[str, Tuple[float, float]],
) -> Tuple[List[List], List[List[float]]]:
    """Reconstruit la suite d'arêtes de source à dest : d'un côté les
    segments fusionnés par type ("walk"/"steps"/"elevator", niveaux) pour
    les instructions, de l'autre la géométrie complète (simplifiée par RDP)
    pour tracer le chemin réel sur la carte plutôt qu'un trait à vol
    d'oiseau."""
    chain: List[Tuple] = []  # (node, kind, level, seconds), de source (exclu) à dest
    node = dest
    guard = 0
    while node != source and node in prev and guard < 5000:
        guard += 1
        parent, kind, level, w = prev[node]
        chain.append((node, kind, level, w))
        node = parent
    chain.reverse()

    segments: List[List] = []
    for _, kind, level, w in chain:
        if segments and segments[-1][0] == kind and segments[-1][1] == level:
            segments[-1][2] += w
        else:
            segments.append([kind, level, w])
    segments = [[k, list(lv) if lv else None, round(s)] for k, lv, s in segments if s >= MIN_SEGMENT_S or k != "walk"]

    raw_coords = [_coord_of(source, node_coords, anchors)] + [
        _coord_of(n, node_coords, anchors) for n, _, _, _ in chain
    ]
    if len(raw_coords) > 2:
        keep_idx = rdp_indices([(lat, lon) for lon, lat in raw_coords], RDP_EPSILON_DEG)
        coords = [raw_coords[i] for i in keep_idx]
    else:
        coords = raw_coords

    return segments, coords


def build_footpaths(anchors: Dict[str, Tuple[float, float]], graph: GraphBuilder) -> Dict[str, List[List]]:
    node_index = SpatialIndex(graph.node_coords)

    # Rattache chaque arrêt au nœud du graphe piéton le plus proche, puis
    # relie les arrêts entre eux via des nœuds virtuels "stop:<id>" pour que
    # Dijkstra distingue directement les résultats par stop_id GTFS.
    stop_node_key = "stop:{}"
    adj = graph.adj
    n_snapped = 0
    for sid, (lon, lat) in anchors.items():
        snapped = snap_anchor(lon, lat, node_index)
        if snapped is None:
            continue
        n_snapped += 1
        d = haversine_m(lon, lat, *node_index.points[snapped]) / WALK_SPEED_MPS
        vkey = stop_node_key.format(sid)
        adj[vkey].append((snapped, d, "walk", None))
        adj[snapped].append((vkey, d, "walk", None))

    log(f"  arrêts rattachés au graphe piéton : {n_snapped}/{len(anchors)}")

    footpaths: Dict[str, List[List]] = {}
    for sid in anchors:
        vkey = stop_node_key.format(sid)
        if vkey not in adj:
            continue
        dist, prev = dijkstra(adj, vkey, TIME_CUTOFF_S)
        others = []
        for key, seconds in dist.items():
            if not isinstance(key, str) or not key.startswith("stop:"):
                continue
            other_sid = key[len("stop:"):]
            if other_sid == sid or seconds <= 0:
                continue
            others.append((other_sid, seconds))
        if not others:
            continue
        others.sort(key=lambda x: x[1])
        kept = others[:MAX_NEIGHBORS]
        entries = []
        for oid, sec in kept:
            segments, coords = reconstruct_path(prev, vkey, stop_node_key.format(oid), graph.node_coords, anchors)
            entries.append([oid, round(sec), segments, coords])
        footpaths[sid] = entries
    return footpaths


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
        tmp_path = os.path.join(DATA_DIR, ".footpaths_download.pbf")
        with open(tmp_path, "wb") as f:
            f.write(pbf_bytes)
        cleanup = True

    try:
        log("Passe 1/2 : localisation des arrêts + nœuds ascenseurs")
        pass1 = AnchorAndElevatorExtractor()
        pass1.apply_file(tmp_path, locations=True)
        anchors = pass1.resolve_anchors()
        log(f"  arrêts localisés : {len(anchors)} | nœuds ascenseur : {len(pass1.elevator_ids)}")

        anchor_index = SpatialIndex(anchors)

        log("Passe 2/2 : construction du graphe piéton (abords des arrêts)")
        graph = GraphBuilder(anchor_index, pass1.elevator_ids, pass1.elevator_levels)
        graph.apply_file(tmp_path, locations=True)
        log(f"  ways retenues : {graph.n_ways_kept} | nœuds graphe : {len(graph.node_coords)}")

        log("Calcul des correspondances à pied (Dijkstra borné par arrêt)")
        footpaths = build_footpaths(anchors, graph)
    finally:
        if cleanup and os.path.exists(tmp_path):
            os.remove(tmp_path)

    result = {
        "meta": {
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "source": source,
            "source_sha256": sha256_hex(pbf_bytes),
            "counts": {
                "anchors": len(anchors),
                "graph_nodes": len(graph.node_coords),
                "stops_with_footpaths": len(footpaths),
            },
        },
        "footpaths": footpaths,
    }

    log(f"  arrêts avec au moins une correspondance calculée : {len(footpaths)}")

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        import json
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = os.path.getsize(OUT_PATH) / 1024
    log(f"  écrit footpaths.json ({size_kb:.1f} Ko)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
