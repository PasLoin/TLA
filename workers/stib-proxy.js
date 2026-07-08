const ALLOWED_ORIGIN = "https://pasloin.github.io";

const DATASETS = {
  VehiclePositions:
    "https://api-management-opendata-production.azure-api.net/api/datasets/stibmivb/rt/VehiclePositions",
  WaitingTimes:
    "https://api-management-opendata-production.azure-api.net/api/datasets/stibmivb/rt/WaitingTimes",
};

// Seuls ces paramètres de requête sont transmis à l'API amont (Opendatasoft).
// Tout paramètre non listé est ignoré silencieusement.
const ALLOWED_UPSTREAM_PARAMS = new Set([
  "where",
  "limit",
  "offset",
  "order_by",
  "select",
  "refine",
  "exclude",
  "group_by",
]);

// pointid="12345" — on n'autorise qu'un identifiant alphanumérique simple.
const WHERE_PARAM_RE = /^pointid="[A-Za-z0-9_-]{1,32}"$/;

const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes
const SESSION_RATE_LIMIT = { limit: 5, windowSeconds: 300 }; // 5 vérifs Turnstile / 5 min / IP
const PROXY_RATE_LIMIT = { limit: 30, windowSeconds: 60 }; // 30 requêtes / min / IP

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);

    // --- Préflight CORS -----------------------------------------------
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    // --- Contrôle d'origine strict (défense en profondeur, en plus du
    //     CORS qui n'est appliqué que par les navigateurs) --------------
    if (origin !== ALLOWED_ORIGIN) {
      return json({ error: "Origine non autorisée" }, 403, origin);
    }

    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown";

    // --- Endpoint d'échange Turnstile -> jeton de session --------------
    if (url.pathname === "/session") {
      if (request.method !== "POST") {
        return json({ error: "Méthode non autorisée" }, 405, origin);
      }

      const allowed = await checkRateLimit(
        env.RATE_LIMIT_KV,
        `session:${clientIp}`,
        SESSION_RATE_LIMIT
      );
      if (!allowed) {
        return json({ error: "Trop de tentatives, réessaie plus tard" }, 429, origin);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Corps JSON invalide" }, 400, origin);
      }

      const turnstileToken = body && body.token;
      if (!turnstileToken || typeof turnstileToken !== "string") {
        return json({ error: "Jeton Turnstile manquant" }, 400, origin);
      }

      const verified = await verifyTurnstile(
        turnstileToken,
        env.TURNSTILE_SECRET_KEY,
        clientIp
      );
      if (!verified) {
        return json({ error: "Vérification Turnstile échouée" }, 403, origin);
      }

      const sessionToken = await createSessionToken(env.SESSION_HMAC_SECRET);
      return json(
        { sessionToken, expiresIn: SESSION_TTL_SECONDS },
        200,
        origin
      );
    }

    // --- Proxy de données (nécessite une session valide) ---------------
    if (request.method !== "GET") {
      return json({ error: "Méthode non autorisée" }, 405, origin);
    }

    const sessionToken = request.headers.get("X-Session-Token") || "";
    const validSession = await verifySessionToken(
      sessionToken,
      env.SESSION_HMAC_SECRET
    );
    if (!validSession) {
      return json({ error: "Session absente, expirée ou invalide" }, 401, origin);
    }

    const allowed = await checkRateLimit(
      env.RATE_LIMIT_KV,
      `proxy:${clientIp}`,
      PROXY_RATE_LIMIT
    );
    if (!allowed) {
      return json({ error: "Trop de requêtes, réessaie plus tard" }, 429, origin);
    }

    const datasetName = url.searchParams.get("dataset") || "VehiclePositions";
    const baseUrl = DATASETS[datasetName];
    if (!baseUrl) {
      return json({ error: `dataset inconnu: ${datasetName}` }, 400, origin);
    }

    const whereParam = url.searchParams.get("where");
    if (whereParam !== null && !WHERE_PARAM_RE.test(whereParam)) {
      return json({ error: "Paramètre 'where' invalide" }, 400, origin);
    }

    const upstream = new URL(baseUrl);
    for (const [key, value] of url.searchParams) {
      if (key === "dataset") continue;
      if (!ALLOWED_UPSTREAM_PARAMS.has(key)) continue; // liste blanche stricte
      upstream.searchParams.set(key, value);
    }
    if (!upstream.searchParams.has("limit")) {
      upstream.searchParams.set("limit", "1000");
    }

    let upstreamResp;
    try {
      upstreamResp = await fetch(upstream.toString(), {
        headers: { "bmc-partner-key": env.BMC_PARTNER_KEY },
      });
    } catch (err) {
      return json({ error: "Erreur de communication avec l'API amont" }, 502, origin);
    }

    const data = await upstreamResp.text();

    return new Response(data, {
      status: upstreamResp.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders(origin),
        ...securityHeaders(),
      },
    });
  },
};

// ---------------------------------------------------------------------
// En-têtes
// ---------------------------------------------------------------------

function corsHeaders(origin) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Session-Token",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
  if (origin === ALLOWED_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  }
  return headers;
}

function securityHeaders() {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "cross-origin",
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders(origin),
      ...securityHeaders(),
    },
  });
}

// ---------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------

async function verifyTurnstile(token, secret, remoteip) {
  if (!secret) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (remoteip && remoteip !== "unknown") form.append("remoteip", remoteip);

  try {
    const res = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      { method: "POST", body: form }
    );
    const outcome = await res.json();
    return outcome.success === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Jetons de session signés (HMAC-SHA256, sans état côté serveur)
// ---------------------------------------------------------------------

async function getHmacKey(secret) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

function toBase64Url(bytes) {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const bin = atob(padded + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function createSessionToken(secret) {
  if (!secret) throw new Error("SESSION_HMAC_SECRET manquant");
  const payload = JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS });
  const payloadB64 = toBase64Url(new TextEncoder().encode(payload));
  const key = await getHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  const sigB64 = toBase64Url(new Uint8Array(sig));
  return `${payloadB64}.${sigB64}`;
}

async function verifySessionToken(token, secret) {
  if (!secret || !token || !token.includes(".")) return false;
  const [payloadB64, sigB64] = token.split(".");
  if (!payloadB64 || !sigB64) return false;

  try {
    const key = await getHmacKey(secret);
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(sigB64),
      new TextEncoder().encode(payloadB64)
    );
    if (!valid) return false;

    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
    return typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------
// Rate limiting (KV, fenêtre glissante approximative par minute)
// ---------------------------------------------------------------------

async function checkRateLimit(kv, key, { limit, windowSeconds }) {
  if (!kv) return true; // pas de binding configuré -> ne bloque pas (dégradé, pas cassé)

  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const kvKey = `${key}:${bucket}`;

  let count = 0;
  try {
    const current = await kv.get(kvKey);
    count = current ? parseInt(current, 10) : 0;
  } catch {
    return true; // en cas d'erreur KV, on ne bloque pas l'utilisateur légitime
  }

  if (count >= limit) return false;

  try {
    await kv.put(kvKey, String(count + 1), { expirationTtl: windowSeconds + 5 });
  } catch {
    // silencieux : au pire le compteur n'est pas incrémenté
  }
  return true;
}
