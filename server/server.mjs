// Backend for the Polotno + Fourthwall demo.
//
// The editor runs in the browser, so it cannot hold the Fourthwall credentials.
// This server holds them and exposes:
//
//   GET /health
//   GET /fourthwall/print-area
//   POST /fourthwall/mockups
//
// Env:
//   FOURTHWALL_USERNAME, FOURTHWALL_PASSWORD
//   ALLOWED_ORIGINS comma-separated, defaults to localhost:5173

import http from 'node:http';

const env = process.env;
const PORT = Number(env.PORT || 8787);
const PUBLIC_URL = (env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const ALLOWED_ORIGINS = (
  env.ALLOWED_ORIGINS ||
  'http://localhost:5173'
).split(',');

const SIDES = ['front', 'back'];

const MAX_BODY = 25 * 1024 * 1024;

// --- helpers ------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function cached(fn, ttlMs = 60 * 60 * 1000) {
  const cache = new Map();
  return async (key) => {
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value;
    const value = await fn(key);
    cache.set(key, { value, expires: Date.now() + ttlMs });
    return value;
  };
}

async function api(base, token, path, { method = 'GET', body, headers = {} } = {}) {
  // A provider with its own auth header passes Authorization: undefined.
  const allHeaders = Object.fromEntries(
    Object.entries({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }).filter(
      ([, v]) => v !== undefined
    )
  );
  const res = await fetch(base + path, {
    method,
    headers: allHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    const detail = json?.error?.message || json?.message || json?.result || text;
    throw new HttpError(502, `${method} ${path} failed (${res.status}): ${detail}`);
  }
  return json;
}

// The demo posts base64 PNGs per side. Keep only real, non-empty PNG data.
function readSides(body) {
  const sides = {};
  for (const side of SIDES) {
    const value = body?.files?.[side];
    if (!value) continue;
    const base64 = String(value).replace(/^data:image\/png;base64,/, '');
    if (!base64.startsWith('iVBOR')) throw new HttpError(400, `${side} is not a PNG`);
    sides[side] = base64;
  }
  if (!Object.keys(sides).length) throw new HttpError(400, 'No design to send');
  return sides;
}

// --- Fourthwall ----------------------------------------------------------------

const FW_API = 'https://api.fourthwall.com/open-api/v1.0';
// Gildan Lightweight Fashion T-Shirt, DTG: Fourthwall renders its mockups.
const FW_TEMPLATE = env.FOURTHWALL_TEMPLATE_ID || 'pro_5786d059adeb42899b';
const FW_COLORS = { black: 'Black', blue: 'Royal Blue', red: 'Red' };
// The demo's sides, mapped to the template's regions.
const FW_REGIONS = { front: 'front_large', back: 'back' };

const fourthwall = (path, opts = {}) => {
  if (!env.FOURTHWALL_USERNAME || !env.FOURTHWALL_PASSWORD) {
    throw new HttpError(503, 'FOURTHWALL_USERNAME and FOURTHWALL_PASSWORD are not set');
  }
  const basic = Buffer.from(`${env.FOURTHWALL_USERNAME}:${env.FOURTHWALL_PASSWORD}`).toString('base64');
  return api(FW_API, basic, path, { ...opts, headers: { Authorization: `Basic ${basic}`, ...opts.headers } });
};

const fourthwallTemplate = cached(() => fourthwall(`/product-templates/${FW_TEMPLATE}`));

async function fourthwallPrintArea() {
  const template = await fourthwallTemplate('template');
  const areas = {};
  for (const [side, regionId] of Object.entries(FW_REGIONS)) {
    const d = template.customizableAreas.find((a) => a.regionId === regionId)?.dimensions;
    if (d) areas[side] = { width: d.pixelsWidth, height: d.pixelsHeight, dpi: d.dpi };
  }
  return { template: template.name, areas, request: `GET ${FW_API}/product-templates/${FW_TEMPLATE}` };
}

/** Width and height from a PNG's header. */
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

async function fourthwallMockups(body) {
  const sides = readSides(body);
  const color = FW_COLORS[body.color] || 'Black';

  const regions = [];
  for (const [side, base64] of Object.entries(sides)) {
    const png = Buffer.from(base64, 'base64');
    const upload = await fourthwall('/media/upload-url', {
      method: 'POST',
      body: { fileName: `polotno-demo-${side}.png`, contentType: 'image/png', size: png.length },
    });
    const put = await fetch(upload.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'x-goog-content-length-range': `0,${png.length}` },
      body: png,
    });
    if (!put.ok) throw new HttpError(502, `Fourthwall upload failed (${put.status})`);
    const image = await fourthwall('/media/images', {
      method: 'POST',
      body: { fileUrl: upload.fileUrl, ...pngSize(png) },
    });
    regions.push({ region: FW_REGIONS[side], imageId: image.id, placementStrategy: 'FULL_REGION' });
  }

  const productBody = {
    type: 'design',
    productTemplateId: FW_TEMPLATE,
    name: 'Polotno demo tee',
    description: 'Created by the Polotno SDK demo and deleted right after.',
    colors: [color],
    regions,
    publishOnCreate: false,
  };
  const product = await fourthwall('/products', { method: 'POST', body: productBody });

  try {
    const wanted = regions.map((r) => (r.region === 'front_large' ? 'front' : r.region));
    const mockups = (product.images || [])
      .filter((img) => img.color === color && wanted.includes(img.region))
      .map((img) => ({ side: `${img.region}, ${color}`, url: img.url }));
    return {
      mockups,
      requests: [
        {
          title: 'Upload each side, then register it as an image',
          endpoint: `POST ${FW_API}/media/upload-url → PUT → POST ${FW_API}/media/images`,
          body: { fileName: 'polotno-demo-front.png', contentType: 'image/png', size: '<bytes>' },
        },
        {
          title: 'Create the design product (hidden)',
          endpoint: `POST ${FW_API}/products`,
          body: productBody,
        },
      ],
    };
  } finally {
    // The demo only needs the mockups; keep the shop clean.
    fourthwall(`/products/${product.productId}`, { method: 'DELETE' }).catch((e) =>
      console.error('fourthwall cleanup failed', e.message)
    );
  }
}

// --- rate limit -----------------------------------------------------------------

const hits = new Map();
function rateLimit(ip, limit = 12, windowMs = 60 * 1000) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) throw new HttpError(429, 'Too many requests, try again in a minute');
  recent.push(now);
  hits.set(ip, recent);
}

// --- server ---------------------------------------------------------------------

const routes = {
  'GET /health': async () => ({ ok: true }),
  'GET /fourthwall/print-area': () => fourthwallPrintArea(),
  'POST /fourthwall/mockups': (body) => fourthwallMockups(body),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Design too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {});
      } catch {
        reject(new HttpError(400, 'Body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, PUBLIC_URL);
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const route = routes[`${req.method} ${url.pathname}`];
  try {
    if (!route) throw new HttpError(404, 'Not found');
    if (req.method === 'POST') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
        .split(',')[0]
        .trim();
      rateLimit(ip);
    }
    const body = req.method === 'POST' ? await readBody(req) : null;
    const result = await route(body, url.searchParams);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(req.method, url.pathname, e.message);
    res
      .writeHead(status, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`pod-proxy listening on ${PORT}`));
