
const DATASETS = {
  VehiclePositions:
    "https://api-management-opendata-production.azure-api.net/api/datasets/stibmivb/rt/VehiclePositions",
  WaitingTimes:
    "https://api-management-opendata-production.azure-api.net/api/datasets/stibmivb/rt/WaitingTimes",
};

export default {
  async fetch(request, env, ctx) {
    
    const allowedOrigin = "https://pasloin.github.io";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(allowedOrigin) });
    }
    if (request.method !== "GET") {
      return json({ error: "Méthode non autorisée" }, 405, allowedOrigin);
    }

    const url = new URL(request.url);
    const datasetName = url.searchParams.get("dataset") || "VehiclePositions";
    const baseUrl = DATASETS[datasetName];
    if (!baseUrl) {
      return json({ error: `dataset inconnu: ${datasetName}` }, 400, allowedOrigin);
    }

    const upstream = new URL(baseUrl);
    for (const [key, value] of url.searchParams) {
      if (key === "dataset") continue;
      upstream.searchParams.set(key, value);
    }
    if (!upstream.searchParams.has("limit")) {
      upstream.searchParams.set("limit", "1000");
    }

    const upstreamResp = await fetch(upstream.toString(), {
      headers: { "bmc-partner-key": env.BMC_PARTNER_KEY },
    });
    const data = await upstreamResp.text();

    return new Response(data, {
      status: upstreamResp.status,
      headers: { "Content-Type": "application/json", ...corsHeaders(allowedOrigin) },
    });
  },
};

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}
