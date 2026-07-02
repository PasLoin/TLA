/* ==========================================================================
   STIB·MIVB — Simulation temps réel
   --------------------------------------------------------------------------
   Charge les fichiers data/*.json (générés par scripts/fetch_and_process.py)
   et simule, pour une date/heure donnée, la position de chaque véhicule en
   service en interpolant entre ses deux arrêts encadrants (le long du tracé
   réel de la ligne quand il est disponible), en marquant un temps d'arrêt à
   quai (réel si fourni par le GTFS, sinon une pause minimale imposée — voir
   MIN_DWELL_SECONDS plus bas) plutôt qu'un glissement continu.

   Format des données (voir scripts/fetch_and_process.py pour le détail) :
     routes.json   : { route_id: {short_name, long_name, type, color, text_color} }
     stops.json    : { stop_id: {name, lat, lon} }
     shapes.json   : { shape_id: [[dist_km, lon, lat], ...] }   (trié par dist)
     calendar.json : [ {service_id, days:[L,Ma,Me,J,V,S,D], start_date, end_date} ]
     calendar_dates.json : [ {service_id, date:'YYYYMMDD', exception_type} ]
     trips.json    : [ [trip_id, route_id, service_id, shape_id|null,
                         direction_id, headsign, stops, stopseq_idx] ]
       - avec tracé : stops = [[arr_sec, dep_sec, dist_km], ...]
       - sans tracé : stops = [[arr_sec, dep_sec, lon, lat], ...]
       - stopseq_idx : index dans stop_sequences.json (liste des stop_id
         desservis, alignée 1:1 avec stops) — utilisé par le planificateur
     stop_sequences.json : [ [stop_id, ...], ... ] séquences d'arrêts dédupliquées
     stop_shape_index.json : { route_short_name: { stop_id: [shape_id, dist_km] } }
       (sert uniquement au mode "temps réel manuel" ci-dessous)

   --------------------------------------------------------------------------
   Planificateur d'itinéraire (RAPTOR)
   --------------------------------------------------------------------------
   Choix d'un point de départ et d'arrivée par clic sur la carte. On cherche
   les arrêts accessibles à pied autour de chaque point, puis on exécute
   l'algorithme RAPTOR (Round-bAsed Public Transit Optimized Router) sur les
   horaires du jour simulé : chaque "round" k explore les trajets atteignables
   avec au plus k-1 correspondances, en relaxant ensuite les transferts à pied
   entre arrêts proches. On présente les alternatives Pareto-optimales
   (arrivée la plus tôt pour chaque nombre de correspondances). L'heure de
   départ est la date/heure de la simulation.

   --------------------------------------------------------------------------
   Mode "temps réel" (manuel)
   --------------------------------------------------------------------------
   Sur clic du bouton "Récupérer le temps réel", l'app appelle un proxy
   Cloudflare Worker (qui détient la clé API STIB côté serveur) renvoyant les
   données brutes de l'API VehiclePositions de la STIB. Ce format ne fournit
   ni coordonnées GPS ni identité de véhicule, seulement, par ligne, une liste
   de { directionId, pointId, distanceFromPoint } : un véhicule se trouve à
   distanceFromPoint mètres après l'arrêt pointId. On reprojette donc cette
   position sur le tracé de la ligne via stop_shape_index.json (qui indique,
   pour cet arrêt précis sur cette ligne, à quelle distance cumulée du tracé
   il correspond), en ajoutant distanceFromPoint. C'est un instantané figé
   (pas d'animation), affiché avec un style visuel distinct des véhicules
   simulés, jusqu'au prochain clic.
   ========================================================================== */

(() => {
  "use strict";

  const DATA_BASE = "data/";
  const UPDATE_INTERVAL_MS = 1000; // fréquence de recalcul des positions

  const REALTIME_PROXY_URL = "https://stib-realtime-proxy.pulpfiction4651694.workers.dev" // ;

  const ROUTE_TYPE_RADIUS = { 0: 6, 1: 7, 3: 5 }; // tram, métro, bus
  const ROUTE_TYPE_DEFAULT_RADIUS = 5.5;

  // ------------------------------------------------------------------------
  // État global de la simulation
  // ------------------------------------------------------------------------
  const state = {
    simTime: new Date(),
    speed: 1,
    playing: true,
    candidatesDate: null, // 'YYYYMMDD' du jour pour lequel les candidats sont calculés
    candidates: [],        // [{trip, offset}]
    stopsVisible: false,
  };

  let routesData = {};
  let stopsData = {};
  let shapesData = {};
  let calendarData = [];
  let exceptionsByDate = new Map(); // 'YYYYMMDD' -> {added:Set, removed:Set}
  let tripsData = [];
  let tripsByService = new Map(); // service_id -> [trip, ...]   (perf: éviter de scanner tous les trips)
  let stopShapeIndex = {};        // route_short_name -> { stop_id: [shape_id, dist_km] }
  let routesByShortName = new Map(); // short_name -> {route_id, ...routeData}
  let stopSequencesData = null;   // [[stop_id, ...], ...] — null si données non régénérées

  // ------------------------------------------------------------------------
  // Utilitaires date / heure
  // ------------------------------------------------------------------------

  function pad2(n) { return String(n).padStart(2, "0"); }

  function yyyymmdd(d) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  }

  function isoDateInput(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function isoTimeInput(d) {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }

  function addDays(d, n) {
    const r = new Date(d);
    r.setDate(r.getDate() + n);
    return r;
  }

  const WEEKDAY_LABELS_FR = [
    "dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi",
  ];

  function formatHumanDate(d) {
    return `${WEEKDAY_LABELS_FR[d.getDay()]} ${d.getDate()} ${d.toLocaleString("fr-FR", { month: "long" })} ${d.getFullYear()}`;
  }

  // ------------------------------------------------------------------------
  // Chargement des données
  // ------------------------------------------------------------------------

  async function fetchJSON(name) {
    const res = await fetch(DATA_BASE + name, { cache: "no-store" });
    if (!res.ok) throw new Error(`Impossible de charger ${name} (${res.status})`);
    return res.json();
  }

  async function loadAll() {
    const [meta, routes, stops, shapes, calendar, calendarDates, trips, stopShapeIdx] = await Promise.all([
      fetchJSON("meta.json"),
      fetchJSON("routes.json"),
      fetchJSON("stops.json"),
      fetchJSON("shapes.json"),
      fetchJSON("calendar.json"),
      fetchJSON("calendar_dates.json"),
      fetchJSON("trips.json"),
      fetchJSON("stop_shape_index.json"),
    ]);

    // Optionnel (planificateur) : absent si les données n'ont pas encore été
    // régénérées avec la version du script qui l'exporte.
    try {
      stopSequencesData = await fetchJSON("stop_sequences.json");
    } catch (e) {
      stopSequencesData = null;
    }

    routesData = routes;
    stopsData = stops;
    shapesData = shapes;
    calendarData = calendar;
    tripsData = trips;
    stopShapeIndex = stopShapeIdx;

    routesByShortName = new Map();
    for (const [routeId, r] of Object.entries(routesData)) {
      if (r.short_name && !routesByShortName.has(r.short_name)) {
        routesByShortName.set(r.short_name, { route_id: routeId, ...r });
      }
    }

    exceptionsByDate = new Map();
    for (const ex of calendarDates) {
      let bucket = exceptionsByDate.get(ex.date);
      if (!bucket) {
        bucket = { added: new Set(), removed: new Set() };
        exceptionsByDate.set(ex.date, bucket);
      }
      if (ex.exception_type === 1) bucket.added.add(ex.service_id);
      else if (ex.exception_type === 2) bucket.removed.add(ex.service_id);
    }

    tripsByService = new Map();
    for (const t of tripsData) {
      const serviceId = t[2];
      let arr = tripsByService.get(serviceId);
      if (!arr) { arr = []; tripsByService.set(serviceId, arr); }
      arr.push(t);
    }

    updateDataFooter(meta);
    return meta;
  }

  function updateDataFooter(meta) {
    const el = document.getElementById("dataFoot");
    if (!el) return;
    const gen = meta.generated_at ? new Date(meta.generated_at) : null;
    const genStr = gen ? gen.toLocaleString("fr-FR") : "—";
    const period = (meta.feed_start_date && meta.feed_end_date)
      ? `${formatGtfsDate(meta.feed_start_date)} → ${formatGtfsDate(meta.feed_end_date)}`
      : "—";
    el.innerHTML =
      `Données GTFS ${meta.agency_name || "STIB-MIVB"} — version ${meta.feed_version || "?"}<br>` +
      `Validité : ${period}<br>Mise à jour des données : ${genStr}`;
  }

  function formatGtfsDate(s) {
    if (!s || s.length !== 8) return s;
    return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`;
  }

  // ------------------------------------------------------------------------
  // Calendrier GTFS : services actifs pour une date donnée
  // ------------------------------------------------------------------------

  const activeServicesCache = new Map();

  function getActiveServices(dateObj) {
    const key = yyyymmdd(dateObj);
    if (activeServicesCache.has(key)) return activeServicesCache.get(key);

    const dow = (dateObj.getDay() + 6) % 7; // 0=lundi ... 6=dimanche
    const active = new Set();
    for (const cal of calendarData) {
      if (cal.days[dow] === 1 && key >= cal.start_date && key <= cal.end_date) {
        active.add(cal.service_id);
      }
    }
    const ex = exceptionsByDate.get(key);
    if (ex) {
      for (const s of ex.added) active.add(s);
      for (const s of ex.removed) active.delete(s);
    }
    activeServicesCache.set(key, active);
    return active;
  }

  // ------------------------------------------------------------------------
  // Construction des trajets "candidats" pour une date donnée
  //
  // Un trajet GTFS est rattaché à un "jour de service" mais ses horaires
  // peuvent dépasser 24:00:00 (ex: 25:10:00 = 01:10 le lendemain). On
  // constitue donc deux groupes :
  //   - offset 0     : services actifs le jour J, comparés aux horaires bruts
  //   - offset 86400 : services actifs le jour J-1 dont le trajet déborde
  //                    après minuit, comparés à (heure courante + 24h)
  // ------------------------------------------------------------------------

  function buildCandidatesForDate(dateObj) {
    const key = yyyymmdd(dateObj);
    if (state.candidatesDate === key) return;

    const dayServices = getActiveServices(dateObj);
    const prevServices = getActiveServices(addDays(dateObj, -1));

    const candidates = [];
    for (const serviceId of dayServices) {
      const trips = tripsByService.get(serviceId);
      if (trips) for (const t of trips) candidates.push({ trip: t, offset: 0 });
    }
    for (const serviceId of prevServices) {
      const trips = tripsByService.get(serviceId);
      if (!trips) continue;
      for (const t of trips) {
        const stops = t[6];
        if (stops[stops.length - 1][1] >= 86400) {
          candidates.push({ trip: t, offset: 86400 });
        }
      }
    }

    state.candidates = candidates;
    state.candidatesDate = key;
  }

  // ------------------------------------------------------------------------
  // Interpolation de position
  // ------------------------------------------------------------------------

  function bracketIndexInStops(stops, value) {
    // recherche binaire de l'indice lo tel que stops[lo][0] <= value <= stops[lo+1][0]
    let lo = 0, hi = stops.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (stops[mid][0] <= value) lo = mid; else hi = mid;
    }
    return lo;
  }

  function positionOnShape(shapePoints, dist) {
    // shapePoints: [[dist_km, lon, lat], ...] trié par dist croissant
    const n = shapePoints.length;
    if (dist <= shapePoints[0][0]) return [shapePoints[0][1], shapePoints[0][2]];
    if (dist >= shapePoints[n - 1][0]) return [shapePoints[n - 1][1], shapePoints[n - 1][2]];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (shapePoints[mid][0] <= dist) lo = mid; else hi = mid;
    }
    const a = shapePoints[lo], b = shapePoints[hi];
    const span = b[0] - a[0];
    const f = span > 0 ? (dist - a[0]) / span : 0;
    return [a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
  }

  // Temps d'arrêt minimum imposé visuellement à chaque station (en secondes),
  // même quand le GTFS ne distingue pas arrival_time et departure_time (cas
  // de la grande majorité des arrêts STIB). Si le flux fournit un dwell réel
  // plus long, c'est celui-ci qui prime. On ne le laisse jamais dépasser
  // MIN_DWELL_MAX_FRACTION du temps de trajet vers l'arrêt suivant, pour ne
  // pas créer d'arrêts absurdes sur des sauts très courts entre deux points.
  const MIN_DWELL_SECONDS = 12;
  const MIN_DWELL_MAX_FRACTION = 0.4;

  function computeFeatures() {
    const secOfDay =
      state.simTime.getHours() * 3600 +
      state.simTime.getMinutes() * 60 +
      state.simTime.getSeconds();

    const features = [];
    for (const c of state.candidates) {
      const t = c.trip;
      const [tripId, routeId, , shapeId, directionId, headsign, stops] = t;
      const compareTime = secOfDay + c.offset;
      const firstT = stops[0][0];
      const lastT = stops[stops.length - 1][1];
      if (compareTime < firstT || compareTime > lastT) continue;

      const idx = bracketIndexInStops(stops, compareTime);
      const s0 = stops[idx];
      const s1 = stops[Math.min(idx + 1, stops.length - 1)];

      // s0 = [arrivalSec, departureSec, ...position]. Tant que compareTime
      // est compris dans la fenêtre d'arrêt (réelle ou minimale imposée), le
      // véhicule reste figé sur la position de s0 au lieu de continuer à
      // glisser vers s1.
      const totalSpan = s1[0] - s0[0];
      const realDwell = Math.max(0, s0[1] - s0[0]);
      const dwell =
        totalSpan > 0
          ? Math.min(Math.max(realDwell, MIN_DWELL_SECONDS), totalSpan * MIN_DWELL_MAX_FRACTION)
          : 0;

      let f;
      if (totalSpan <= 0) {
        f = 0;
      } else if (compareTime - s0[0] < dwell) {
        f = 0; // encore à quai
      } else {
        const travelSpan = totalSpan - dwell;
        f = travelSpan > 0 ? (compareTime - s0[0] - dwell) / travelSpan : 1;
      }

      let lon, lat;
      if (shapeId) {
        const shape = shapesData[shapeId];
        if (!shape) continue;
        const d = s0[2] + f * (s1[2] - s0[2]);
        [lon, lat] = positionOnShape(shape, d);
      } else {
        lon = s0[2] + f * (s1[2] - s0[2]);
        lat = s0[3] + f * (s1[3] - s0[3]);
      }

      const route = routesData[routeId] || {};
      features.push({
        type: "Feature",
        properties: {
          tripId,
          routeId,
          shortName: route.short_name || "",
          headsign,
          directionId,
          routeType: route.type ?? 3,
          color: "#" + (route.color || "1d4ed8"),
          textColor: "#" + (route.text_color || "ffffff"),
          radius: ROUTE_TYPE_RADIUS[route.type] || ROUTE_TYPE_DEFAULT_RADIUS,
        },
        geometry: { type: "Point", coordinates: [lon, lat] },
      });
    }
    return features;
  }

  // ------------------------------------------------------------------------
  // Planificateur d'itinéraire (RAPTOR) — voir le commentaire d'en-tête.
  // ------------------------------------------------------------------------

  const WALK_SPEED_MPS = 1.25;        // ~4,5 km/h
  const MAX_WALK_ORIGIN_M = 700;      // rayon de recherche des arrêts de départ/arrivée
  const MAX_WALK_ORIGIN_FALLBACK_M = 1500; // rayon élargi si rien dans le premier
  const MAX_ORIGIN_STOPS = 6;         // nb max d'arrêts candidats de chaque côté
  const TRANSFER_RADIUS_M = 250;      // distance max d'une correspondance à pied
  const TRANSFER_WALK_PENALTY_S = 30; // marge fixe ajoutée à chaque transfert à pied
  const TRANSFER_BUFFER_S = 60;       // marge min pour attraper un véhicule après un autre
  const MAX_ROUNDS = 4;               // jusqu'à 3 correspondances

  const plannerState = {
    picking: null,       // 'origin' | 'dest' | null
    origin: null,        // {lon, lat}
    dest: null,
    originMarker: null,
    destMarker: null,
    // Structures RAPTOR, reconstruites quand la date change :
    timetableDateKey: null,
    patterns: [],        // [{routeId, stopIds, trips:[{stops, offset, headsign, shapeId}]}]
    routesAtStop: null,  // Map stop_id -> [[patternIdx, posInPattern], ...]
    footpaths: null,     // Map stop_id -> [[stop_id, walkSec], ...]
    stopGrid: null,      // index spatial des arrêts
    journeys: [],
  };

  function metersBetween(lat1, lon1, lat2, lon2) {
    const dlat = lat2 - lat1;
    const dlon = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    return Math.hypot(dlat, dlon) * 111320;
  }

  // ---- Index spatial des arrêts (grille) --------------------------------

  const GRID_CELL_DEG = 0.004; // ~440 m N-S

  function buildStopGrid() {
    const grid = new Map();
    for (const [id, s] of Object.entries(stopsData)) {
      const key = `${Math.floor(s.lat / GRID_CELL_DEG)}:${Math.floor(s.lon / GRID_CELL_DEG)}`;
      let arr = grid.get(key);
      if (!arr) { arr = []; grid.set(key, arr); }
      arr.push(id);
    }
    return grid;
  }

  function stopsNear(lat, lon, radiusM) {
    if (!plannerState.stopGrid) plannerState.stopGrid = buildStopGrid();
    const latCells = Math.ceil(radiusM / (GRID_CELL_DEG * 111320)) + 1;
    const lonCellM = GRID_CELL_DEG * 111320 * Math.cos(lat * Math.PI / 180);
    const lonCells = Math.ceil(radiusM / lonCellM) + 1;
    const ci = Math.floor(lat / GRID_CELL_DEG);
    const cj = Math.floor(lon / GRID_CELL_DEG);
    const out = [];
    for (let di = -latCells; di <= latCells; di++) {
      for (let dj = -lonCells; dj <= lonCells; dj++) {
        const cell = plannerState.stopGrid.get(`${ci + di}:${cj + dj}`);
        if (!cell) continue;
        for (const id of cell) {
          const s = stopsData[id];
          const d = metersBetween(lat, lon, s.lat, s.lon);
          if (d <= radiusM) out.push([id, d]);
        }
      }
    }
    out.sort((a, b) => a[1] - b[1]);
    return out;
  }

  function accessStops(lat, lon) {
    let found = stopsNear(lat, lon, MAX_WALK_ORIGIN_M);
    if (found.length === 0) found = stopsNear(lat, lon, MAX_WALK_ORIGIN_FALLBACK_M);
    return found
      .slice(0, MAX_ORIGIN_STOPS)
      .map(([id, d]) => [id, Math.round(d / WALK_SPEED_MPS)]);
  }

  // ---- Transferts à pied entre arrêts proches ----------------------------

  function ensureFootpaths() {
    if (plannerState.footpaths) return;
    const fp = new Map();
    for (const [id, s] of Object.entries(stopsData)) {
      const near = stopsNear(s.lat, s.lon, TRANSFER_RADIUS_M);
      const list = [];
      for (const [nid, d] of near) {
        if (nid === id) continue;
        list.push([nid, Math.round(d / WALK_SPEED_MPS) + TRANSFER_WALK_PENALTY_S]);
      }
      if (list.length) fp.set(id, list);
    }
    plannerState.footpaths = fp;
  }

  // ---- Construction de la table horaire du jour (patterns RAPTOR) --------
  //
  // Regroupe les trajets candidats du jour (déjà filtrés par calendrier via
  // buildCandidatesForDate, y compris les trajets nocturnes de la veille avec
  // offset 86400) par "pattern" = même route + même séquence exacte d'arrêts.
  // Convention temporelle : temps "effectif" = temps GTFS brut - offset,
  // exprimé en secondes depuis minuit du jour de la requête (cohérent avec
  // compareTime = secOfDay + offset utilisé dans computeFeatures).

  function tripDep(trip, si) { return trip.stops[si][1] - trip.offset; }
  function tripArr(trip, si) { return trip.stops[si][0] - trip.offset; }

  function buildPlannerTimetable(dateObj) {
    const key = yyyymmdd(dateObj);
    if (plannerState.timetableDateKey === key) return;
    buildCandidatesForDate(dateObj);

    const patternMap = new Map();
    for (const c of state.candidates) {
      const t = c.trip;
      const stops = t[6];
      const seqIdx = t[7];
      if (seqIdx === undefined || !stopSequencesData) continue;
      const stopIds = stopSequencesData[seqIdx];
      if (!stopIds || stopIds.length !== stops.length || stops.length < 2) continue;
      const sig = t[1] + "|" + seqIdx;
      let p = patternMap.get(sig);
      if (!p) {
        p = { routeId: t[1], stopIds, trips: [] };
        patternMap.set(sig, p);
      }
      p.trips.push({ stops, offset: c.offset, headsign: t[5], shapeId: t[3], tripId: t[0] });
    }
    const patterns = [...patternMap.values()];
    for (const p of patterns) p.trips.sort((a, b) => tripDep(a, 0) - tripDep(b, 0));

    const routesAtStop = new Map();
    patterns.forEach((p, pi) => {
      p.stopIds.forEach((sid, si) => {
        let arr = routesAtStop.get(sid);
        if (!arr) { arr = []; routesAtStop.set(sid, arr); }
        arr.push([pi, si]);
      });
    });

    plannerState.patterns = patterns;
    plannerState.routesAtStop = routesAtStop;
    plannerState.timetableDateKey = key;
  }

  // Premier trajet du pattern p attrapable à l'arrêt d'index si à partir de
  // l'instant readyAt (recherche binaire ; hypothèse standard : pas de
  // dépassement entre véhicules d'un même pattern).
  function earliestTrip(p, si, readyAt) {
    const trips = p.trips;
    let lo = 0, hi = trips.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tripDep(trips[mid], si) < readyAt) lo = mid + 1;
      else hi = mid;
    }
    return lo < trips.length ? trips[lo] : null;
  }

  // ---- Cœur RAPTOR --------------------------------------------------------

  function runRaptor(originStops, destStops, depSec) {
    ensureFootpaths();
    const INF = Infinity;
    const bestArr = new Map();
    const roundArr = [new Map()];
    const parents = [new Map()];

    for (const [sid, w] of originStops) {
      const t = depSec + w;
      if (t < (roundArr[0].get(sid) ?? INF)) {
        roundArr[0].set(sid, t);
        bestArr.set(sid, t);
        parents[0].set(sid, { type: "origin", walkSec: w });
      }
    }
    let marked = new Set(roundArr[0].keys());

    for (let k = 1; k <= MAX_ROUNDS && marked.size; k++) {
      roundArr[k] = new Map(roundArr[k - 1]);
      parents[k] = new Map();

      // Routes desservant au moins un arrêt marqué, avec le plus petit index
      // marqué (on ne scanne le pattern qu'à partir de là).
      const queue = new Map();
      for (const sid of marked) {
        const lst = plannerState.routesAtStop.get(sid);
        if (!lst) continue;
        for (const [pi, si] of lst) {
          const cur = queue.get(pi);
          if (cur === undefined || si < cur) queue.set(pi, si);
        }
      }

      const newMarked = new Set();
      for (const [pi, startIdx] of queue) {
        const p = plannerState.patterns[pi];
        let trip = null, boardIdx = -1;
        for (let si = startIdx; si < p.stopIds.length; si++) {
          const sid = p.stopIds[si];
          if (trip) {
            const arr = tripArr(trip, si);
            if (arr < (bestArr.get(sid) ?? INF)) {
              roundArr[k].set(sid, arr);
              bestArr.set(sid, arr);
              parents[k].set(sid, {
                type: "ride", pattern: pi, trip, boardIdx, alightIdx: si,
              });
              newMarked.add(sid);
            }
          }
          // Peut-on attraper un véhicule plus tôt à cet arrêt ?
          const tauPrev = roundArr[k - 1].get(sid);
          if (tauPrev !== undefined) {
            const readyAt = tauPrev + (k > 1 ? TRANSFER_BUFFER_S : 0);
            const cand = earliestTrip(p, si, readyAt);
            if (cand && (!trip || tripDep(cand, si) < tripDep(trip, si))) {
              trip = cand;
              boardIdx = si;
            }
          }
        }
      }

      // Relaxation des transferts à pied (un saut par round, standard RAPTOR).
      for (const sid of [...newMarked]) {
        const t0 = roundArr[k].get(sid);
        const fps = plannerState.footpaths.get(sid);
        if (!fps) continue;
        for (const [nsid, w] of fps) {
          const t = t0 + w;
          if (t < (bestArr.get(nsid) ?? INF)) {
            roundArr[k].set(nsid, t);
            bestArr.set(nsid, t);
            parents[k].set(nsid, { type: "walk", from: sid, walkSec: w });
            newMarked.add(nsid);
          }
        }
      }
      marked = newMarked;
    }

    // Extraction des alternatives Pareto : pour chaque round, meilleure
    // arrivée à destination (arrêt + marche finale) ; on ne garde que les
    // rounds qui améliorent strictement l'arrivée.
    const journeys = [];
    let bestSoFar = INF;
    for (let k = 1; k < roundArr.length; k++) {
      let best = null;
      for (const [sid, w] of destStops) {
        const t = roundArr[k].get(sid);
        if (t === undefined) continue;
        const tot = t + w;
        if (!best || tot < best.tot) best = { sid, walkSec: w, tot };
      }
      if (best && best.tot < bestSoFar) {
        const legs = reconstructJourney(parents, k, best.sid);
        if (legs && legs.some((l) => l.type === "ride")) {
          bestSoFar = best.tot;
          journeys.push({
            departure: depSec,
            arrival: best.tot,
            finalWalkSec: best.walkSec,
            transfers: legs.filter((l) => l.type === "ride").length - 1,
            legs,
          });
        }
      }
    }
    return journeys;
  }

  // Remonte les pointeurs parents depuis (arrêt, round) jusqu'à l'origine.
  function reconstructJourney(parents, k, stopId) {
    const legs = [];
    let sid = stopId;
    let guard = 0;
    while (k >= 0 && guard++ < 200) {
      const e = parents[k].get(sid);
      if (!e) { k -= 1; continue; } // valeur héritée d'un round antérieur
      if (e.type === "origin") {
        legs.unshift({ type: "walkOrigin", toStop: sid, walkSec: e.walkSec });
        return legs;
      }
      if (e.type === "walk") {
        legs.unshift({ type: "walkTransfer", fromStop: e.from, toStop: sid, walkSec: e.walkSec });
        sid = e.from;
        continue; // même round : le prédécesseur a été marqué par un ride du round k
      }
      // ride
      const p = plannerState.patterns[e.pattern];
      legs.unshift({
        type: "ride",
        routeId: p.routeId,
        headsign: e.trip.headsign,
        shapeId: e.trip.shapeId,
        trip: e.trip,
        boardStop: p.stopIds[e.boardIdx],
        alightStop: p.stopIds[e.alightIdx],
        boardIdx: e.boardIdx,
        alightIdx: e.alightIdx,
        depSec: tripDep(e.trip, e.boardIdx),
        arrSec: tripArr(e.trip, e.alightIdx),
        nStops: e.alightIdx - e.boardIdx,
      });
      sid = p.stopIds[e.boardIdx];
      k -= 1;
    }
    return null; // reconstruction incohérente : on écarte ce trajet
  }

  // ---- Recherche complète (points -> arrêts -> RAPTOR) --------------------

  function planJourneys() {
    const resultsEl = document.getElementById("plannerResults");
    const hint = document.getElementById("plannerHint");
    if (!plannerState.origin || !plannerState.dest) return;

    if (!stopSequencesData || !tripsData.length || tripsData[0][7] === undefined) {
      if (hint) hint.textContent =
        "Données incompatibles : régénère data/ avec scripts/fetch_and_process.py --force.";
      return;
    }

    buildPlannerTimetable(state.simTime);
    const depSec =
      state.simTime.getHours() * 3600 +
      state.simTime.getMinutes() * 60 +
      state.simTime.getSeconds();

    const originStops = accessStops(plannerState.origin.lat, plannerState.origin.lon);
    const destStops = accessStops(plannerState.dest.lat, plannerState.dest.lon);
    if (!originStops.length || !destStops.length) {
      renderJourneys([], "Aucun arrêt à distance de marche d'un des deux points.");
      return;
    }

    const journeys = runRaptor(originStops, destStops, depSec);
    plannerState.journeys = journeys;
    renderJourneys(
      journeys,
      journeys.length
        ? null
        : "Aucun itinéraire trouvé à cette heure (essaie une autre heure ou d'autres points)."
    );
    if (journeys.length) drawJourney(journeys[0]);
    if (resultsEl) resultsEl.scrollTop = 0;
  }

  // ---- Rendu des résultats -------------------------------------------------

  function fmtHM(sec) {
    const s = ((sec % 86400) + 86400) % 86400;
    return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
  }

  function fmtDurationMin(sec) {
    const m = Math.max(1, Math.round(sec / 60));
    return m >= 60 ? `${Math.floor(m / 60)} h ${pad2(m % 60)}` : `${m} min`;
  }

  function stopName(id) {
    const s = stopsData[id];
    return s ? s.name : id;
  }

  function renderJourneys(journeys, emptyMessage) {
    const el = document.getElementById("plannerResults");
    if (!el) return;
    el.innerHTML = "";
    if (!journeys.length) {
      if (emptyMessage) {
        const p = document.createElement("p");
        p.className = "planner-empty";
        p.textContent = emptyMessage;
        el.appendChild(p);
      }
      return;
    }
    journeys.forEach((j, ji) => {
      const div = document.createElement("div");
      div.className = "journey" + (ji === 0 ? " journey-selected" : "");
      const dur = j.arrival - j.departure;
      const transfersLabel =
        j.transfers === 0 ? "direct" : `${j.transfers} corresp.`;
      let html =
        `<div class="journey-head">` +
        `<span class="journey-times">${fmtHM(j.departure)} → ${fmtHM(j.arrival)}</span>` +
        `<span class="journey-meta">${fmtDurationMin(dur)} · ${transfersLabel}</span>` +
        `</div><ul class="journey-legs">`;
      for (const leg of j.legs) {
        if (leg.type === "walkOrigin") {
          html += `<li class="leg leg-walk">🚶 ${fmtDurationMin(leg.walkSec)} à pied vers <b>${escapeHtml(stopName(leg.toStop))}</b></li>`;
        } else if (leg.type === "walkTransfer") {
          html += `<li class="leg leg-walk">🚶 ${fmtDurationMin(leg.walkSec)} à pied vers <b>${escapeHtml(stopName(leg.toStop))}</b></li>`;
        } else {
          const r = routesData[leg.routeId] || {};
          const color = "#" + (r.color || "1d4ed8");
          const textColor = "#" + (r.text_color || "ffffff");
          html +=
            `<li class="leg leg-ride">` +
            `<span class="leg-line" style="background:${color};color:${textColor}">${escapeHtml(r.short_name || "?")}</span>` +
            `<span class="leg-detail">dir. ${escapeHtml(leg.headsign || "—")}<br>` +
            `<b>${escapeHtml(stopName(leg.boardStop))}</b> ${fmtHM(leg.depSec)} → ` +
            `<b>${escapeHtml(stopName(leg.alightStop))}</b> ${fmtHM(leg.arrSec)}` +
            ` <span class="leg-nstops">(${leg.nStops} arrêt${leg.nStops > 1 ? "s" : ""})</span></span>` +
            `</li>`;
        }
      }
      if (j.finalWalkSec > 0) {
        html += `<li class="leg leg-walk">🚶 ${fmtDurationMin(j.finalWalkSec)} à pied jusqu'à destination</li>`;
      }
      html += `</ul>`;
      div.innerHTML = html;
      div.addEventListener("click", () => {
        el.querySelectorAll(".journey").forEach((n) => n.classList.remove("journey-selected"));
        div.classList.add("journey-selected");
        drawJourney(j);
      });
      el.appendChild(div);
    });
  }

  // ---- Tracé de l'itinéraire sur la carte ----------------------------------

  function shapeSegment(shapeId, d0, d1) {
    const shape = shapesData[shapeId];
    if (!shape) return null;
    if (d1 < d0) { const t = d0; d0 = d1; d1 = t; }
    const coords = [positionOnShape(shape, d0)];
    for (const pt of shape) {
      if (pt[0] > d0 && pt[0] < d1) coords.push([pt[1], pt[2]]);
    }
    coords.push(positionOnShape(shape, d1));
    return coords;
  }

  function legLineCoords(leg) {
    if (leg.shapeId && shapesData[leg.shapeId]) {
      const seg = shapeSegment(
        leg.shapeId,
        leg.trip.stops[leg.boardIdx][2],
        leg.trip.stops[leg.alightIdx][2]
      );
      if (seg && seg.length >= 2) return seg;
    }
    const a = stopsData[leg.boardStop];
    const b = stopsData[leg.alightStop];
    if (!a || !b) return null;
    return [[a.lon, a.lat], [b.lon, b.lat]];
  }

  function drawJourney(j) {
    if (!map.getSource("journey")) return;
    const features = [];
    let prevPoint = plannerState.origin ? [plannerState.origin.lon, plannerState.origin.lat] : null;
    for (const leg of j.legs) {
      if (leg.type === "ride") {
        const coords = legLineCoords(leg);
        if (coords) {
          const r = routesData[leg.routeId] || {};
          features.push({
            type: "Feature",
            properties: { kind: "ride", color: "#" + (r.color || "1d4ed8") },
            geometry: { type: "LineString", coordinates: coords },
          });
          prevPoint = coords[coords.length - 1];
        }
      } else {
        const to = stopsData[leg.toStop];
        if (prevPoint && to) {
          features.push({
            type: "Feature",
            properties: { kind: "walk", color: "#64748b" },
            geometry: { type: "LineString", coordinates: [prevPoint, [to.lon, to.lat]] },
          });
        }
        if (to) prevPoint = [to.lon, to.lat];
      }
    }
    if (prevPoint && plannerState.dest) {
      features.push({
        type: "Feature",
        properties: { kind: "walk", color: "#64748b" },
        geometry: {
          type: "LineString",
          coordinates: [prevPoint, [plannerState.dest.lon, plannerState.dest.lat]],
        },
      });
    }
    map.getSource("journey").setData({ type: "FeatureCollection", features });
  }

  function clearJourneyDrawing() {
    if (map.getSource("journey")) {
      map.getSource("journey").setData({ type: "FeatureCollection", features: [] });
    }
  }

  function addJourneyLayer() {
    map.addSource("journey", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
    map.addLayer({
      id: "journey-line",
      type: "line",
      source: "journey",
      filter: ["==", ["get", "kind"], "ride"],
      paint: { "line-color": ["get", "color"], "line-width": 5, "line-opacity": 0.85 },
    });
    map.addLayer({
      id: "journey-walk",
      type: "line",
      source: "journey",
      filter: ["==", ["get", "kind"], "walk"],
      paint: {
        "line-color": ["get", "color"],
        "line-width": 3,
        "line-opacity": 0.8,
        "line-dasharray": [1, 1.6],
      },
    });
  }

  // ---- Interaction : choix des points sur la carte -------------------------

  function setPickMode(mode) {
    plannerState.picking = plannerState.picking === mode ? null : mode;
    const originBtn = document.getElementById("plannerOriginBtn");
    const destBtn = document.getElementById("plannerDestBtn");
    if (originBtn) originBtn.classList.toggle("btn-active", plannerState.picking === "origin");
    if (destBtn) destBtn.classList.toggle("btn-active", plannerState.picking === "dest");
    map.getCanvas().style.cursor = plannerState.picking ? "crosshair" : "";
    const hint = document.getElementById("plannerHint");
    if (hint && plannerState.picking) {
      hint.textContent = plannerState.picking === "origin"
        ? "Clique sur la carte pour placer le point de départ."
        : "Clique sur la carte pour placer le point d'arrivée.";
    }
  }

  function placePlannerPoint(lngLat) {
    const mode = plannerState.picking;
    if (!mode) return;
    const point = { lon: lngLat.lng, lat: lngLat.lat };
    const isOrigin = mode === "origin";
    const markerKey = isOrigin ? "originMarker" : "destMarker";
    if (plannerState[markerKey]) plannerState[markerKey].remove();
    plannerState[markerKey] = new maplibregl.Marker({ color: isOrigin ? "#4ade80" : "#ef4444" })
      .setLngLat([point.lon, point.lat])
      .addTo(map);
    plannerState[isOrigin ? "origin" : "dest"] = point;
    setPickMode(mode); // désactive le mode après placement

    const hint = document.getElementById("plannerHint");
    const searchBtn = document.getElementById("plannerSearchBtn");
    const ready = plannerState.origin && plannerState.dest;
    if (searchBtn) searchBtn.disabled = !ready;
    if (hint) {
      hint.textContent = ready
        ? "Prêt — la recherche part à la date/heure de la simulation ci-dessus."
        : (isOrigin ? "Départ placé. Place maintenant l'arrivée." : "Arrivée placée. Place maintenant le départ.");
    }
  }

  function clearPlanner() {
    if (plannerState.originMarker) plannerState.originMarker.remove();
    if (plannerState.destMarker) plannerState.destMarker.remove();
    plannerState.originMarker = plannerState.destMarker = null;
    plannerState.origin = plannerState.dest = null;
    plannerState.journeys = [];
    if (plannerState.picking) setPickMode(plannerState.picking);
    clearJourneyDrawing();
    const el = document.getElementById("plannerResults");
    if (el) el.innerHTML = "";
    const searchBtn = document.getElementById("plannerSearchBtn");
    if (searchBtn) searchBtn.disabled = true;
    const hint = document.getElementById("plannerHint");
    if (hint) hint.textContent = "Choisis un départ et une arrivée sur la carte.";
  }

  // ------------------------------------------------------------------------
  // Mode "temps réel" (manuel) — voir le commentaire d'en-tête du fichier.
  // ------------------------------------------------------------------------

  const realtimeState = {
    fetching: false,
    lastFetchAt: null,
    count: 0,
  };

  function resolveLineKey(lineid) {
    if (stopShapeIndex[lineid]) return lineid;
    if (lineid.startsWith("T") && stopShapeIndex[lineid.slice(1)]) return lineid.slice(1);
    return null;
  }

  function resolveRouteMeta(lineid) {
    if (routesByShortName.has(lineid)) return routesByShortName.get(lineid);
    if (lineid.startsWith("T") && routesByShortName.has(lineid.slice(1))) {
      return routesByShortName.get(lineid.slice(1));
    }
    return null;
  }

  // À partir d'une entrée brute { directionId, pointId, distanceFromPoint }
  // de l'API VehiclePositions, calcule une position [lon, lat] approximative.
  // Retourne null si on ne peut pas la situer du tout (arrêt inconnu).
  function placeRealtimeVehicle(lineid, pointId, distanceFromPoint) {
    const lineKey = resolveLineKey(lineid);
    if (lineKey) {
      const entry = stopShapeIndex[lineKey][pointId];
      if (entry) {
        const [shapeId, distKm] = entry;
        const shape = shapesData[shapeId];
        if (shape) {
          const target = distKm + (distanceFromPoint || 0) / 1000;
          const [lon, lat] = positionOnShape(shape, target);
          return [lon, lat];
        }
      }
    }
    // Repli : position brute de l'arrêt référencé (sans tenir compte de
    // distanceFromPoint), si on la connaît.
    const stop = stopsData[pointId];
    if (stop) return [stop.lon, stop.lat];
    return null;
  }

  function realtimeFeaturesFromResults(results) {
    const features = [];
    for (const entry of results) {
      const lineid = entry.lineid;
      let positions;
      try {
        // Le champ est une chaîne JSON imbriquée dans le JSON de réponse.
        positions = JSON.parse(entry.vehiclepositions);
      } catch (e) {
        continue;
      }
      const routeMeta = resolveRouteMeta(lineid);
      for (const vp of positions) {
        const coords = placeRealtimeVehicle(lineid, vp.pointId, vp.distanceFromPoint);
        if (!coords) continue;
        features.push({
          type: "Feature",
          properties: {
            lineid,
            pointId: vp.pointId,
            directionId: vp.directionId,
            distanceFromPoint: vp.distanceFromPoint,
            color: "#" + ((routeMeta && routeMeta.color) || "1d4ed8"),
          },
          geometry: { type: "Point", coordinates: coords },
        });
      }
    }
    return features;
  }

  async function fetchRealtime() {
    if (!REALTIME_PROXY_URL || realtimeState.fetching) return;
    const btn = document.getElementById("realtimeBtn");
    const status = document.getElementById("realtimeStatus");
    realtimeState.fetching = true;
    if (btn) { btn.disabled = true; btn.textContent = "Récupération…"; }
    if (status) status.textContent = "Appel de l'API en cours…";

    try {
      const res = await fetch(`${REALTIME_PROXY_URL}?dataset=VehiclePositions`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Réponse ${res.status}`);
      const data = await res.json();
      const features = realtimeFeaturesFromResults(data.results || []);
      if (map.getSource("vehicles-realtime")) {
        map.getSource("vehicles-realtime").setData({ type: "FeatureCollection", features });
      }
      realtimeState.lastFetchAt = new Date();
      realtimeState.count = features.length;
      if (status) {
        status.textContent =
          `${features.length} véhicule(s) — capturé à ${isoTimeInput(realtimeState.lastFetchAt)}`;
      }
    } catch (err) {
      console.error(err);
      if (status) status.textContent = "Échec de la récupération (voir la console).";
    } finally {
      realtimeState.fetching = false;
      if (btn) { btn.disabled = false; btn.textContent = "Récupérer le temps réel"; }
    }
  }

  function clearRealtime() {
    if (map.getSource("vehicles-realtime")) {
      map.getSource("vehicles-realtime").setData({ type: "FeatureCollection", features: [] });
    }
    realtimeState.lastFetchAt = null;
    realtimeState.count = 0;
    const status = document.getElementById("realtimeStatus");
    if (status) status.textContent = "Aucune donnée temps réel chargée.";
  }

  // ------------------------------------------------------------------------
  // Panneau d'attente (façon afficheur de quai) — clic sur un arrêt
  // ------------------------------------------------------------------------
  //
  // ⚠️ Le format exact de l'API WaitingTimes n'a pas pu être vérifié contre
  // une vraie réponse (la doc OpenAPI fournie est un gabarit générique,
  // identique à celle de VehiclePositions qui s'est révélée différente du
  // format réel une fois testée). Le parsing ci-dessous est une estimation
  // raisonnable basée sur le format connu des API STIB classiques
  // (résultats groupés par arrêt, avec un champ "passingtimes" contenant un
  // tableau JSON imbriqué de { destination: {fr, nl}, expectedArrivalTime,
  // lineId }). Teste avec un vrai arrêt et regarde la console (le JSON brut
  // y est toujours affiché) — si l'affichage est vide ou incorrect alors
  // que la console montre des données, le format diffère et le parsing est
  // à ajuster.

  const boardState = { stopId: null, stopName: null, fetching: false };

  function openBoard(stopId, stopName) {
    boardState.stopId = stopId;
    boardState.stopName = stopName;
    const board = document.getElementById("departureBoard");
    const nameEl = document.getElementById("boardStopName");
    const status = document.getElementById("boardStatus");
    const list = document.getElementById("boardList");
    if (!board) return;
    board.classList.remove("hidden");
    if (nameEl) nameEl.textContent = stopName || stopId;
    if (list) list.innerHTML = "";
    if (status) {
      status.textContent = REALTIME_PROXY_URL
        ? "Clique sur Rafraîchir pour voir les prochains passages."
        : "Proxy temps réel non configuré (REALTIME_PROXY_URL).";
    }
  }

  function closeBoard() {
    const board = document.getElementById("departureBoard");
    if (board) board.classList.add("hidden");
    boardState.stopId = null;
  }

  function parseWaitingTimes(json) {
    // Format confirmé contre une vraie réponse de l'API le 30/06/2026 :
    // results: [{ pointid, lineid, passingtimes: "[{destination:{fr,nl},
    // expectedArrivalTime, lineId, message?:{fr,nl,en,de}}, ...]" }]
    // On garde quelques replis de casse par prudence (ça ne coûte rien),
    // on déduplique (l'API renvoie parfois deux entrées identiques pour une
    // même ligne déviée) et on remonte le message de perturbation s'il y en
    // a un.
    const out = [];
    const seen = new Set();
    const results = json.results || json.Results || [];
    for (const entry of results) {
      const rawTimes =
        entry.passingtimes ?? entry.passingTimes ?? entry.waitingtimes ?? entry.waitingTimes;
      let times = null;
      if (typeof rawTimes === "string") {
        try { times = JSON.parse(rawTimes); } catch (e) { times = null; }
      } else if (Array.isArray(rawTimes)) {
        times = rawTimes;
      }
      if (!times) continue;
      for (const t of times) {
        const lineid = entry.lineid ?? entry.lineId ?? t.lineId ?? t.lineid ?? "";
        const dest =
          (t.destination && (t.destination.fr || t.destination.nl)) ||
          t.destination || t.headsign || "";
        const expected =
          t.expectedArrivalTime || t.expectedDepartureTime || t.arrivalTime || null;
        const note = t.message && (t.message.fr || t.message.nl || t.message.en) || null;

        const dedupeKey = `${lineid}|${dest}|${expected}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);

        out.push({ lineid: String(lineid), destination: dest, expected, note });
      }
    }
    out.sort((a, b) => {
      const ta = a.expected ? Date.parse(a.expected) : Infinity;
      const tb = b.expected ? Date.parse(b.expected) : Infinity;
      return ta - tb;
    });
    return out;
  }

  function minutesUntil(isoString) {
    if (!isoString) return null;
    const t = new Date(isoString).getTime();
    if (Number.isNaN(t)) return null;
    return Math.round((t - Date.now()) / 60000);
  }

  function renderBoard(entries) {
    const list = document.getElementById("boardList");
    if (!list) return;
    list.innerHTML = "";
    if (entries.length === 0) {
      const li = document.createElement("li");
      li.className = "board-empty";
      li.textContent = "Aucun passage annoncé pour le moment.";
      list.appendChild(li);
      return;
    }
    for (const e of entries) {
      const routeMeta = resolveRouteMeta(e.lineid);
      const color = "#" + ((routeMeta && routeMeta.color) || "1d4ed8");
      const textColor = "#" + ((routeMeta && routeMeta.text_color) || "ffffff");
      const mins = minutesUntil(e.expected);
      const minsLabel = mins === null ? "—" : mins <= 0 ? "à l'arrêt" : `${mins} min`;

      const li = document.createElement("li");
      li.className = "board-row";
      li.innerHTML =
        `<span class="board-line" style="background:${color};color:${textColor}">${escapeHtml(e.lineid)}</span>` +
        `<span class="board-dest">` +
          `<span class="board-dest-name">${escapeHtml(e.destination || "—")}</span>` +
          (e.note ? `<span class="board-note">${escapeHtml(e.note)}</span>` : "") +
        `</span>` +
        `<span class="board-eta">${escapeHtml(minsLabel)}</span>`;
      list.appendChild(li);
    }
  }

  // Filtre serveur confirmé fonctionnel le 30/06/2026 (where=pointid="X").
  // L'échec initial observé (filtered_count: 0, data_processed_count
  // anormalement bas) était un faux négatif ponctuel — vraisemblablement le
  // store temps réel pris en plein cycle de rafraîchissement interne — et
  // non un problème de syntaxe ou un bug structurel. Un seul appel API par
  // clic, filtré directement côté serveur sur l'arrêt exact.
  async function fetchWaitingTimes() {
    if (!REALTIME_PROXY_URL || !boardState.stopId || boardState.fetching) return;
    const btn = document.getElementById("boardRefreshBtn");
    const status = document.getElementById("boardStatus");
    boardState.fetching = true;
    if (btn) { btn.disabled = true; btn.textContent = "Récupération…"; }
    if (status) status.textContent = "Appel de l'API en cours…";

    try {
      const params = new URLSearchParams({
        dataset: "WaitingTimes",
        where: `pointid="${boardState.stopId}"`,
      });
      const res = await fetch(`${REALTIME_PROXY_URL}?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Réponse ${res.status}`);
      const data = await res.json();
      console.log("WaitingTimes brut pour", boardState.stopId, data);
      const entries = parseWaitingTimes(data);
      renderBoard(entries);
      if (status) {
        status.textContent = `Mis à jour à ${isoTimeInput(new Date())}` +
          (entries.length === 0 ? " — réessaie si ça semble anormal (voir README)." : "");
      }
    } catch (err) {
      console.error(err);
      if (status) status.textContent = "Échec de la récupération (voir la console).";
    } finally {
      boardState.fetching = false;
      if (btn) { btn.disabled = false; btn.textContent = "Rafraîchir"; }
    }
  }



  let map;
  let vehiclesLoaded = false;

  function initMap() {
    map = new maplibregl.Map({
      container: "map",
      style: "https://tiles.openfreemap.org/styles/positron",
      center: [4.3517, 50.8466],
      zoom: 12.3,
      attributionControl: false,
      maxPitch: 0,
    });
    // Accès debug uniquement (inspection depuis la console : window.__stibMap)
    window.__stibMap = map;

    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        customAttribution: [
          '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
          '© <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>',
          '<a href="https://maplibre.org" target="_blank" rel="noopener">MapLibre</a>',
          'Données GTFS © <a href="https://www.stib-mivb.be/" target="_blank" rel="noopener">STIB-MIVB</a> (Open Data)',
        ],
      }),
      "bottom-right"
    );
  }

  function addStopsLayer() {
    const features = Object.entries(stopsData).map(([id, s]) => ({
      type: "Feature",
      properties: { id, name: s.name },
      geometry: { type: "Point", coordinates: [s.lon, s.lat] },
    }));
    map.addSource("stops", { type: "geojson", data: { type: "FeatureCollection", features } });
    map.addLayer({
      id: "stops-layer",
      type: "circle",
      source: "stops",
      layout: { visibility: "none" },
      paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 16, 5.5],
        "circle-color": "#475569",
        "circle-opacity": 0.95,
        "circle-stroke-width": 1.2,
        "circle-stroke-color": "#ffffff",
      },
    });
    // Noms des arrêts (couche indépendante, masquée par défaut, pilotée par
    // la case "Afficher les noms des arrêts").
    map.addLayer({
      id: "stops-labels",
      type: "symbol",
      source: "stops",
      layout: {
        visibility: "none",
        "text-field": ["get", "name"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12, 9, 16, 12],
        "text-font": ["Noto Sans Regular"],
        "text-offset": [0, 0.9],
        "text-anchor": "top",
        "text-max-width": 9,
        // Laisse MapLibre gérer la densité : les labels en collision sont
        // masqués automatiquement plutôt que de saturer la carte.
        "text-allow-overlap": false,
        "text-optional": true,
      },
      paint: {
        "text-color": "#334155",
        "text-halo-color": "#ffffff",
        "text-halo-width": 1.4,
      },
    });

    map.on("click", "stops-layer", (e) => {
      if (plannerState.picking) return; // le clic sert à placer un point du planificateur
      const f = e.features[0];
      openBoard(f.properties.id, f.properties.name);
    });
    map.on("mouseenter", "stops-layer", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "stops-layer", () => { map.getCanvas().style.cursor = ""; });
  }

  function addVehiclesLayer() {
    map.addSource("vehicles", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    map.addLayer({
      id: "vehicles-circle",
      type: "circle",
      source: "vehicles",
      paint: {
        "circle-radius": ["get", "radius"],
        "circle-color": ["get", "color"],
        "circle-stroke-color": "#ffffff",
        "circle-stroke-width": 1.4,
        "circle-pitch-alignment": "map",
      },
    });

    map.addLayer({
      id: "vehicles-label",
      type: "symbol",
      source: "vehicles",
      layout: {
        "text-field": ["get", "shortName"],
        "text-size": 10,
        "text-allow-overlap": true,
        "text-ignore-placement": true,
        "text-font": ["Noto Sans Bold"],
      },
      paint: {
        "text-color": ["get", "textColor"],
        "text-halo-width": 0,
      },
    });

    map.on("click", "vehicles-circle", (e) => {
      if (plannerState.picking) return;
      const f = e.features[0];
      const p = f.properties;
      new maplibregl.Popup({ closeButton: false })
        .setLngLat(f.geometry.coordinates)
        .setHTML(
          `<div class="vehicle-popup-route">${escapeHtml(p.shortName)} → ${escapeHtml(p.headsign)}</div>` +
          `<div class="vehicle-popup-headsign">Trajet ${escapeHtml(p.tripId)}</div>`
        )
        .addTo(map);
    });
    map.on("mouseenter", "vehicles-circle", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "vehicles-circle", () => { map.getCanvas().style.cursor = ""; });
  }

  function addRealtimeLayer() {
    map.addSource("vehicles-realtime", {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
    });

    // Style délibérément différent des véhicules simulés (anneau creux blanc
    // au lieu d'un disque plein) pour qu'on distingue au premier coup d'œil
    // un instantané "temps réel" d'une position simulée.
    map.addLayer({
      id: "vehicles-realtime-circle",
      type: "circle",
      source: "vehicles-realtime",
      paint: {
        "circle-radius": 8,
        "circle-color": "#ffffff",
        "circle-opacity": 0.15,
        "circle-stroke-color": ["get", "color"],
        "circle-stroke-width": 2.5,
      },
    });

    map.on("click", "vehicles-realtime-circle", (e) => {
      const f = e.features[0];
      const p = f.properties;
      new maplibregl.Popup({ closeButton: false })
        .setLngLat(f.geometry.coordinates)
        .setHTML(
          `<div class="vehicle-popup-route">Ligne ${escapeHtml(p.lineid)} — temps réel</div>` +
          `<div class="vehicle-popup-headsign">+${escapeHtml(p.distanceFromPoint)} m après l'arrêt ${escapeHtml(p.pointId)}</div>`
        )
        .addTo(map);
    });
    map.on("mouseenter", "vehicles-realtime-circle", () => { map.getCanvas().style.cursor = "pointer"; });
    map.on("mouseleave", "vehicles-realtime-circle", () => { map.getCanvas().style.cursor = ""; });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
    ));
  }

  // ------------------------------------------------------------------------
  // Boucle de simulation
  // ------------------------------------------------------------------------

  let lastFrameTs = null;
  let lastTickTs = 0;

  function frame(now) {
    if (lastFrameTs === null) lastFrameTs = now;
    const dtMs = now - lastFrameTs;
    lastFrameTs = now;

    if (state.playing) {
      state.simTime = new Date(state.simTime.getTime() + dtMs * state.speed);
    }

    if (now - lastTickTs >= UPDATE_INTERVAL_MS) {
      lastTickTs = now;
      tick();
    }

    requestAnimationFrame(frame);
  }

  function tick() {
    buildCandidatesForDate(state.simTime);
    updateClockUI();
    if (vehiclesLoaded) {
      const features = computeFeatures();
      map.getSource("vehicles").setData({ type: "FeatureCollection", features });
      document.getElementById("vehicleCount").textContent =
        `${features.length} véhicule${features.length > 1 ? "s" : ""}`;
    }
    syncInputsIfIdle();
  }

  function updateClockUI() {
    document.getElementById("clock").textContent = isoTimeInput(state.simTime);
    document.getElementById("dateLine").textContent = formatHumanDate(state.simTime);
  }

  function syncInputsIfIdle() {
    const dateInput = document.getElementById("dateInput");
    const timeInput = document.getElementById("timeInput");
    if (document.activeElement !== dateInput) dateInput.value = isoDateInput(state.simTime);
    if (document.activeElement !== timeInput) timeInput.value = isoTimeInput(state.simTime);
  }

  // ------------------------------------------------------------------------
  // UI
  // ------------------------------------------------------------------------

  function setStatusMode() {
    const pill = document.getElementById("statusPill");
    const label = document.getElementById("statusLabel");
    if (!state.playing) {
      pill.dataset.mode = "paused";
      label.textContent = "EN PAUSE";
      return;
    }
    const isNow = Math.abs(Date.now() - state.simTime.getTime()) < 2000 && state.speed === 1;
    if (isNow) {
      pill.dataset.mode = "live";
      label.textContent = "TEMPS RÉEL";
    } else {
      pill.dataset.mode = "sim";
      label.textContent = `SIMULÉ ${state.speed}×`;
    }
  }

  function wireUI() {
    const dateInput = document.getElementById("dateInput");
    const timeInput = document.getElementById("timeInput");
    const speedSelect = document.getElementById("speedSelect");
    const playPauseBtn = document.getElementById("playPauseBtn");
    const nowBtn = document.getElementById("nowBtn");
    const stopsToggle = document.getElementById("stopsToggle");
    const panelToggle = document.getElementById("panelToggle");

    dateInput.value = isoDateInput(state.simTime);
    timeInput.value = isoTimeInput(state.simTime);

    function applyInputsToSimTime() {
      const [y, m, d] = dateInput.value.split("-").map(Number);
      const [hh, mm, ss] = timeInput.value.split(":").map(Number);
      if (!y || !m || !d) return;
      state.simTime = new Date(y, m - 1, d, hh || 0, mm || 0, ss || 0, 0);
      setStatusMode();
      tick();
    }

    dateInput.addEventListener("change", applyInputsToSimTime);
    timeInput.addEventListener("change", applyInputsToSimTime);

    speedSelect.addEventListener("change", () => {
      state.speed = Number(speedSelect.value);
      setStatusMode();
    });

    playPauseBtn.addEventListener("click", () => {
      state.playing = !state.playing;
      playPauseBtn.textContent = state.playing ? "⏸" : "▶";
      playPauseBtn.title = state.playing ? "Mettre en pause" : "Reprendre la lecture";
      lastFrameTs = null;
      setStatusMode();
    });

    nowBtn.addEventListener("click", () => {
      state.simTime = new Date();
      state.speed = 1;
      state.playing = true;
      speedSelect.value = "1";
      playPauseBtn.textContent = "⏸";
      lastFrameTs = null;
      setStatusMode();
      tick();
    });

    stopsToggle.addEventListener("change", () => {
      state.stopsVisible = stopsToggle.checked;
      if (map.getLayer("stops-layer")) {
        map.setLayoutProperty("stops-layer", "visibility", state.stopsVisible ? "visible" : "none");
      }
    });

    const stopsNamesToggle = document.getElementById("stopsNamesToggle");
    if (stopsNamesToggle) {
      stopsNamesToggle.addEventListener("change", () => {
        if (map.getLayer("stops-labels")) {
          map.setLayoutProperty(
            "stops-labels",
            "visibility",
            stopsNamesToggle.checked ? "visible" : "none"
          );
        }
      });
    }

    // Planificateur d'itinéraire
    const plannerOriginBtn = document.getElementById("plannerOriginBtn");
    const plannerDestBtn = document.getElementById("plannerDestBtn");
    const plannerSearchBtn = document.getElementById("plannerSearchBtn");
    const plannerClearBtn = document.getElementById("plannerClearBtn");
    if (plannerOriginBtn) plannerOriginBtn.addEventListener("click", () => setPickMode("origin"));
    if (plannerDestBtn) plannerDestBtn.addEventListener("click", () => setPickMode("dest"));
    if (plannerSearchBtn) plannerSearchBtn.addEventListener("click", planJourneys);
    if (plannerClearBtn) plannerClearBtn.addEventListener("click", clearPlanner);
    map.on("click", (e) => {
      if (plannerState.picking) placePlannerPoint(e.lngLat);
    });

    panelToggle.addEventListener("click", () => {
      document.body.classList.toggle("panel-collapsed");
    });

    const realtimeBtn = document.getElementById("realtimeBtn");
    const realtimeClearBtn = document.getElementById("realtimeClearBtn");
    const realtimeStatus = document.getElementById("realtimeStatus");
    if (realtimeBtn) {
      if (!REALTIME_PROXY_URL) {
        realtimeBtn.disabled = true;
        if (realtimeStatus) {
          realtimeStatus.textContent = "Non configuré (renseigne REALTIME_PROXY_URL dans app.js).";
        }
      } else {
        realtimeBtn.addEventListener("click", fetchRealtime);
      }
    }
    if (realtimeClearBtn) realtimeClearBtn.addEventListener("click", clearRealtime);

    const boardRefreshBtn = document.getElementById("boardRefreshBtn");
    const boardCloseBtn = document.getElementById("boardCloseBtn");
    if (boardRefreshBtn) boardRefreshBtn.addEventListener("click", fetchWaitingTimes);
    if (boardCloseBtn) boardCloseBtn.addEventListener("click", closeBoard);

    // Re-vérifie le statut "temps réel" périodiquement (ex: 1x mais date dérive)
    setInterval(setStatusMode, 1000);
  }

  // ------------------------------------------------------------------------
  // Démarrage
  // ------------------------------------------------------------------------

  async function main() {
    initMap();
    wireUI();

    // On attend la fin des DEUX chargements (style/tuiles MapLibre d'un
    // côté, fetch des data/*.json de l'autre) avant de construire les
    // couches qui dépendent de stopsData/routesData. Sans ça, le "load" de
    // la carte arrive souvent plus vite que les fetchs et la couche des
    // arrêts se retrouvait créée avec un stopsData encore vide — figée à
    // 0 feature pour toujours (contrairement aux véhicules, qui se
    // redessinent chaque seconde et s'auto-réparent).
    const mapReady = new Promise((resolve) => map.once("load", resolve));

    try {
      await loadAll();
    } catch (err) {
      console.error(err);
      document.getElementById("dataFoot").textContent =
        "Erreur de chargement des données GTFS. Réessayez plus tard.";
    }
    await mapReady;

    addStopsLayer();
    addVehiclesLayer();
    addRealtimeLayer();
    addJourneyLayer();
    vehiclesLoaded = true;
    document.getElementById("loadingOverlay").classList.add("hidden");

    buildCandidatesForDate(state.simTime);
    setStatusMode();
    requestAnimationFrame(frame);
  }

  main();
})();
