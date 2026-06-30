/* ==========================================================================
   STIB·MIVB — Simulation temps réel
   --------------------------------------------------------------------------
   Charge les fichiers data/*.json (générés par scripts/fetch_and_process.py)
   et simule, pour une date/heure donnée, la position de chaque véhicule en
   service en interpolant linéairement entre ses deux arrêts encadrants
   (le long du tracé réel de la ligne quand il est disponible).

   Format des données (voir scripts/fetch_and_process.py pour le détail) :
     routes.json   : { route_id: {short_name, long_name, type, color, text_color} }
     stops.json    : { stop_id: {name, lat, lon} }
     shapes.json   : { shape_id: [[dist_km, lon, lat], ...] }   (trié par dist)
     calendar.json : [ {service_id, days:[L,Ma,Me,J,V,S,D], start_date, end_date} ]
     calendar_dates.json : [ {service_id, date:'YYYYMMDD', exception_type} ]
     trips.json    : [ [trip_id, route_id, service_id, shape_id|null,
                         direction_id, headsign, stops] ]
       - avec tracé : stops = [[time_sec, dist_km], ...]
       - sans tracé : stops = [[time_sec, lon, lat], ...]
     stop_shape_index.json : { route_short_name: { stop_id: [shape_id, dist_km] } }
       (sert uniquement au mode "temps réel manuel" ci-dessous)

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
        if (stops[stops.length - 1][0] >= 86400) {
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
      const lastT = stops[stops.length - 1][0];
      if (compareTime < firstT || compareTime > lastT) continue;

      const idx = bracketIndexInStops(stops, compareTime);
      const s0 = stops[idx];
      const s1 = stops[Math.min(idx + 1, stops.length - 1)];
      const span = s1[0] - s0[0];
      const f = span > 0 ? (compareTime - s0[0]) / span : 0;

      let lon, lat;
      if (shapeId) {
        const shape = shapesData[shapeId];
        if (!shape) continue;
        const d = s0[1] + f * (s1[1] - s0[1]);
        [lon, lat] = positionOnShape(shape, d);
      } else {
        lon = s0[1] + f * (s1[1] - s0[1]);
        lat = s0[2] + f * (s1[2] - s0[2]);
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
        limit: "50",
      });
      const res = await fetch(`${REALTIME_PROXY_URL}?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`Réponse ${res.status}`);
      const data = await res.json();
      console.log("WaitingTimes brut pour", boardState.stopId, data);
      const entries = parseWaitingTimes(data);
      renderBoard(entries);
      if (status) {
        status.textContent = `Mis à jour à ${isoTimeInput(new Date())}` +
          (entries.length === 0 ? " — voir la console si ça semble anormal." : "");
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

    map.on("load", () => {
      addStopsLayer();
      addVehiclesLayer();
      addRealtimeLayer();
      vehiclesLoaded = true;
      document.getElementById("loadingOverlay").classList.add("hidden");
    });
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
    map.on("click", "stops-layer", (e) => {
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
    try {
      await loadAll();
    } catch (err) {
      console.error(err);
      document.getElementById("dataFoot").textContent =
        "Erreur de chargement des données GTFS. Réessayez plus tard.";
    }
    buildCandidatesForDate(state.simTime);
    setStatusMode();
    requestAnimationFrame(frame);
  }

  main();
})();
