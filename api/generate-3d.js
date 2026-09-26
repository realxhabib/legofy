// Vercel serverless function: turns a photo into a textured 3D model (Hunyuan3D v2, run on fal.ai).
// The API key stays here on the server (set FAL_KEY in the Vercel project's environment variables);
// the page only ever talks to this function, and never names the provider to visitors.
//
//   POST /api/generate-3d   { image: "data:image/jpeg;base64,..." }  ->  { id }
//   GET  /api/generate-3d?id=<request id>  ->  { status, position?, modelUrl? }
//
// Jobs go through fal's queue, so a slow generation never runs into the function's time limit.

const MODEL = 'fal-ai/hunyuan3d/v2';
const QUEUE = 'https://queue.fal.run';
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// Requests for a job's status and result live under the app id (the first two path segments).
const APP = MODEL.split('/').slice(0, 2).join('/');

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
    if (raw.length > MAX_IMAGE_BYTES * 1.4) throw new Error('too large');
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
      try { body = await readJson(req); } catch { return send(res, 413, { error: 'That image is too large.' }); }
      const image = body.image;
      if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
        return send(res, 400, { error: 'Send the photo as a JPEG, PNG or WebP data URL.' });
      }
      if (image.length > MAX_IMAGE_BYTES * 1.37) return send(res, 413, { error: 'That image is too large.' });
      const job = await fal(`${QUEUE}/${MODEL}`, {
        method: 'POST',
        // Always with colours: the LEGO build takes its brick colours from them.
        body: JSON.stringify({ input_image_url: image, textured_mesh: true }),
      });
      return send(res, 200, { id: job.request_id });
    }

    if (req.method === 'GET') {
      const id = new URL(req.url, 'http://x').searchParams.get('id') || '';
      if (!/^[0-9a-f-]{16,64}$/i.test(id)) return send(res, 400, { error: 'Missing or invalid job id.' });
      const status = await fal(`${QUEUE}/${APP}/requests/${id}/status`);
      if (status.status !== 'COMPLETED') {
        return send(res, 200, { status: status.status, position: status.queue_position });
      }
      const result = await fal(`${QUEUE}/${APP}/requests/${id}`);
      const url = result.model_mesh && result.model_mesh.url;
      if (!url) return send(res, 502, { error: 'The model finished without a 3D file.' });
      return send(res, 200, { status: 'COMPLETED', modelUrl: url });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Use GET or POST.' });
  } catch (err) {
    return send(res, err.status && err.status < 500 ? err.status : 502, { error: err.message });
  }
};
