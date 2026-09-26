// Vercel serverless function: turns photos into a textured 3D model (Hunyuan3D v2, run on fal.ai).
// The API key stays here on the server (set FAL_KEY in the Vercel project's environment variables);
// the page only ever talks to this function, and never names the provider to visitors.
//
//   POST /api/generate-3d   { views: { front, back?, left? }, payment? }  ->  { id }
//        payment: the paid Stripe Checkout session id, required once Stripe is set up (see _stripe.js);
//        each payment covers one model plus one retry.
//        (each view a "data:image/jpeg;base64,..." URL; { image } alone still works as the front)
//   GET  /api/generate-3d?id=<id from POST>  ->  { status, position?, modelUrl? }
//
// Front, back and left side together use the multi-view model (more accurate back and sides); a front
// photo alone (or without both of the others) uses the single-photo model. Always textured: the bricks
// take their colours from it.
//
// Jobs go through fal's queue, so a slow generation never runs into the function's time limit.

const payments = require('./_stripe');

const QUEUE = 'https://queue.fal.run';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;   // one photo
const MAX_BODY_BYTES = 12 * 1024 * 1024;   // all of them
const VIEWS = ['front', 'back', 'left'];

const MULTI = 'fal-ai/hunyuan3d/v2/multi-view';
const SINGLE = 'fal-ai/hunyuan3d/v2';
const MODEL = SINGLE; // both live under the same app id, for status checks
const request = (v) => (v.back && v.left
  ? { endpoint: MULTI, input: { front_image_url: v.front, back_image_url: v.back, left_image_url: v.left, textured_mesh: true } }
  : { endpoint: SINGLE, input: { input_image_url: v.front, textured_mesh: true } });
// A job's status and result live under the app id (the first two path segments of the endpoint).
const appOf = (endpoint) => endpoint.split('/').slice(0, 2).join('/');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Only this site may spend the key: the browser's Origin must match the host serving the function.
// Browsers always send Origin with a POST, so a POST without one isn't from the page (a script):
// refuse it. Status checks (GET) may omit it; they cost nothing.
function sameSite(req) {
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES * 1.4) throw new Error('too large');
  }
  return JSON.parse(raw || '{}');
}

async function fal(url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { Authorization: `Key ${process.env.FAL_KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { detail: text }; }
  if (!r.ok) {
    const detail = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || data);
    // The details go to the server log; visitors get a plain message without provider names.
    console.error(`3D provider ${r.status}: ${detail}`.slice(0, 500));
    const err = new Error(r.status === 422
      ? 'The AI couldn\'t use that photo. Try a clearer photo of a single object.'
      : 'The 3D model service is busy or unavailable right now. Please try again in a minute.');
    err.status = r.status;
    throw err;
  }
  return data;
}

module.exports = async function handler(req, res) {
  if (!process.env.FAL_KEY) {
    console.error('FAL_KEY is not set in this Vercel project\'s environment variables.');
    return send(res, 501, { error: 'AI 3D models aren\'t available on this site yet.' });
  }
  if (!sameSite(req)) return send(res, 403, { error: 'Not allowed from this site.' });

  try {
    if (req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch { return send(res, 413, { error: 'Those photos are too large.' }); }
      const views = {};
      const given = body.views || { front: body.image };
      for (const name of VIEWS) {
        const image = given[name];
        if (image == null) continue;
        if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
          return send(res, 400, { error: 'Send each photo as a JPEG, PNG or WebP data URL.' });
        }
        if (image.length > MAX_IMAGE_BYTES * 1.37) return send(res, 413, { error: 'One of the photos is too large.' });
        views[name] = image;
      }
      if (!views.front) return send(res, 400, { error: 'A photo of the front is needed.' });
      // Paid first (when payments are on): checked with Stripe, not trusted from the page.
      let payment = null;
      if (payments.enabled()) {
        payment = await payments.checkPayment(body.payment);
        if (!payment.paid) return send(res, 402, { error: 'Payment needed.', payment: 'required' });
        if (!payment.left) return send(res, 402, { error: 'This payment has been used up. Please pay for a new model.', payment: 'used' });
      }
      const { endpoint, input } = request(views);
      const job = await fal(`${QUEUE}/${endpoint}`, { method: 'POST', body: JSON.stringify(input) });
      if (payment) await payments.useOnce(payment, job.request_id);
      return send(res, 200, { id: job.request_id });
    }

    if (req.method === 'GET') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      if (!/^[0-9a-f-]{16,64}$/i.test(id)) return send(res, 400, { error: 'Missing or invalid job id.' });
      const app = appOf(MODEL);
      const status = await fal(`${QUEUE}/${app}/requests/${id}/status`);
      if (status.status !== 'COMPLETED') {
        return send(res, 200, { status: status.status, position: status.queue_position });
      }
      const result = await fal(`${QUEUE}/${app}/requests/${id}`);
      const url = (result.model_mesh && result.model_mesh.url) || (result.model_glb && result.model_glb.url) ||
        (result.model_urls && result.model_urls.glb && result.model_urls.glb.url);
      if (!url) return send(res, 502, { error: 'The model finished without a 3D file.' });
      return send(res, 200, { status: 'COMPLETED', modelUrl: url });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Use GET or POST.' });
  } catch (err) {
    return send(res, err.status && err.status < 500 ? err.status : 502, { error: err.message });
  }
};
