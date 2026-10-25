(() => {
  "use strict";

  const DATA_BASE = "data/";
  const MANIFEST = "plan/plan.json";
  const SOURCE = "stib-plan";
  const PREFIX = "stib-plan-";
  const OUTLINE = "#1f2430";
  const VEIL = "#f6f6f4";

  let map = null;
  let options = null;
  let manifest = null;
  let current = null;
  let protocolReady = false;

  function ensureProtocol() {
    if (protocolReady) return true;
    if (!window.pmtiles || !window.maplibregl) return false;
    const protocol = new window.pmtiles.Protocol();
    window.maplibregl.addProtocol("pmtiles", protocol.tile);
    protocolReady = true;
    return true;
  }

  function tileUrl(variant) {
    return "pmtiles://" + new URL(DATA_BASE + variant.url, window.location.href).href;
  }

  function lineWidth(minZoom, maxZoom) {
    const w = ["to-number", ["get", "width"], 0];
    const stops = [];
    for (let z = minZoom; z < maxZoom; z++) {
      stops.push(z, ["*", w, 2], z + 0.999, ["*", w, 4]);
    }
    stops.push(maxZoom, ["*", w, 2], maxZoom + 2, ["*", w, 8]);
    return ["interpolate", ["exponential", 2], ["zoom"], ...stops];
  }

  function layerSpecs(variant) {
    const minZoom = variant.min_zoom ?? 10;
    const maxZoom = variant.max_zoom ?? 17;
    const width = lineWidth(minZoom, maxZoom);
    const hidden = { visibility: "none" };
    const outline = ["==", ["get", "color"], "000000"];
    const colored = ["!=", ["get", "color"], "000000"];
    const hex = ["concat", "#", ["get", "color"]];
    const line = (id, sourceLayer, filter, color, cap) => ({
      id: PREFIX + id,
      type: "line",
      source: SOURCE,
      "source-layer": sourceLayer,
      filter,
      layout: { ...hidden, "line-join": "round", "line-cap": cap },
      paint: { "line-color": color, "line-width": width },
    });
    return [
      {
        id: PREFIX + "veil",
        type: "background",
        layout: { ...hidden },
        paint: { "background-color": VEIL, "background-opacity": variant.veil ?? 0.85 },
      },
      line("outline", "lines", outline, OUTLINE, "butt"),
      line("inner-outline", "inner-connections", outline, OUTLINE, "butt"),
      line("line", "lines", colored, hex, "round"),
      line("inner", "inner-connections", colored, hex, "round"),
      {
        id: PREFIX + "station",
        type: "fill",
        source: SOURCE,
        "source-layer": "stations",
        layout: { ...hidden },
        paint: { "fill-color": "#ffffff" },
      },
      {
        id: PREFIX + "station-outline",
        type: "line",
        source: SOURCE,
        "source-layer": "stations",
        layout: { ...hidden, "line-join": "round" },
        paint: {
          "line-color": OUTLINE,
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.8, 16, 2],
        },
      },
      {
        id: PREFIX + "ref",
        type: "symbol",
        source: SOURCE,
        "source-layer": "lines",
        minzoom: 14,
        filter: colored,
        layout: {
          ...hidden,
          "symbol-placement": "line",
          "symbol-spacing": 400,
          "text-field": ["get", "line"],
          "text-font": ["Noto Sans Bold"],
          "text-size": 10,
          "text-rotation-alignment": "viewport",
        },
        paint: { "text-color": "#ffffff", "text-halo-color": hex, "text-halo-width": 3 },
      },
      {
        id: PREFIX + "label",
        type: "symbol",
        source: SOURCE,
        "source-layer": "stations",
        minzoom: 13,
        layout: {
          ...hidden,
          "text-field": ["get", "stationLabel"],
          "text-font": ["Noto Sans Regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 13, 10, 17, 13],
          "text-max-width": 8,
          "text-variable-anchor": ["left", "right", "top", "bottom"],
          "text-radial-offset": 1,
          "text-justify": "auto",
        },
        paint: {
          "text-color": "#1f2430",
          "text-halo-color": "rgba(255,255,255,0.92)",
          "text-halo-width": 1.5,
        },
      },
    ];
  }

  function planLayerIds() {
    return manifest ? layerSpecs(manifest.variants[0]).map((l) => l.id) : [];
  }

  function beforeId() {
    const id = options && options.beforeId;
    return id && map.getLayer(id) ? id : undefined;
  }

  function ensureLayers(variant) {
    if (!ensureProtocol()) throw new Error("pmtiles.js n'est pas chargé");
    if (!map.getSource(SOURCE)) {
      map.addSource(SOURCE, {
        type: "vector",
        url: tileUrl(variant),
        attribution: 'Plan : <a href="https://github.com/ad-freiburg/loom" target="_blank" rel="noopener">LOOM</a>',
      });
      for (const spec of layerSpecs(variant)) map.addLayer(spec, beforeId());
      return;
    }
    const source = map.getSource(SOURCE);
    const url = tileUrl(variant);
    if (source.url !== url && typeof source.setUrl === "function") source.setUrl(url);
  }

  function setPlanVisibility(on) {
    for (const id of planLayerIds()) {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    }
  }

  function hidesGeography() {
    return !!(current && !current.vehicles);
  }

  function applyGeography() {
    const ids = (options && options.geoLayers) || [];
    if (hidesGeography()) {
      for (const id of ids) {
        if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", "none");
      }
    } else if (options && typeof options.restore === "function") {
      options.restore();
    }
  }

  function setStatus(text) {
    const el = document.getElementById("planStatus");
    if (el) el.textContent = text;
  }

  function describe(variant) {
    if (!variant) return "Plan désactivé — carte géographique.";
    return variant.vehicles
      ? "Faisceaux de lignes sur leur tracé réel ; véhicules affichés."
      : "Plan schématique : véhicules, arrêts et itinéraire masqués (positions géographiques).";
  }

  function select(id) {
    const variant = manifest && manifest.variants.find((v) => v.id === id);
    if (!variant) {
      current = null;
      setPlanVisibility(false);
      applyGeography();
      setStatus(describe(null));
      return;
    }
    try {
      ensureLayers(variant);
    } catch (err) {
      console.error(err);
      setStatus("Plan indisponible.");
      return;
    }
    current = variant;
    map.setPaintProperty(PREFIX + "veil", "background-opacity", variant.veil ?? 0.85);
    setPlanVisibility(true);
    applyGeography();
    setStatus(describe(variant));
  }

  function fillSelect(el) {
    el.innerHTML = "";
    const off = document.createElement("option");
    off.value = "";
    off.textContent = "Désactivé (carte)";
    el.appendChild(off);
    for (const v of manifest.variants) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.label;
      el.appendChild(opt);
    }
    el.value = "";
  }

  function onMapError(e) {
    if (!e || e.sourceId !== SOURCE || !current) return;
    const el = document.getElementById("planSelect");
    const opt = el && el.querySelector(`option[value="${current.id}"]`);
    if (opt) opt.disabled = true;
    if (el) el.value = "";
    select("");
    setStatus("Cette représentation n'a pas pu être chargée.");
  }

  async function init(mapInstance, opts) {
    map = mapInstance;
    options = opts || {};
    const block = document.getElementById("planBlock");
    const el = document.getElementById("planSelect");
    if (!block || !el) return;
    try {
      const res = await fetch(DATA_BASE + MANIFEST, { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      manifest = await res.json();
    } catch (err) {
      manifest = null;
    }
    if (!manifest || !Array.isArray(manifest.variants) || manifest.variants.length === 0) {
      block.hidden = true;
      return;
    }
    fillSelect(el);
    block.hidden = false;
    setStatus(describe(null));
    el.addEventListener("change", () => select(el.value));
    map.on("error", onMapError);
  }

  window.StibPlan = { init, hidesGeography, select };
})();
