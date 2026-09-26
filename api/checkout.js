// Payments for the page (Stripe embedded Checkout, see _stripe.js).
//
//   GET  /api/checkout                 -> { enabled, publishableKey?, price: { cents, currency } }
//   POST /api/checkout                 -> { id, clientSecret }   (a new Checkout session for one model)
//   GET  /api/checkout?session=cs_...  -> { paid, left }         (is it paid, how many uses are left)

const { enabled, price, createCheckout, checkPayment } = require('./_stripe');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

// Same rule as the 3D function: only this site may start a payment.
function sameSite(req) {
  const origin = req.headers.origin;
  if (!origin) return req.method === 'GET';
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (!sameSite(req)) return send(res, 403, { error: 'Not allowed from this site.' });
  try {
    if (req.method === 'GET') {
      const session = new URL(req.url, 'http://x').searchParams.get('session');
      if (session) {
        if (!enabled()) return send(res, 200, { paid: true, left: Infinity });
        const c = await checkPayment(session);
        return send(res, 200, { paid: c.paid, left: c.left || 0 });
      }
      return send(res, 200, enabled()
        ? { enabled: true, publishableKey: process.env.STRIPE_PUBLISHABLE_KEY, price: price() }
        : { enabled: false });
    }
    if (req.method === 'POST') {
      if (!enabled()) return send(res, 501, { error: 'Payments aren\'t set up on this site.' });
      return send(res, 200, await createCheckout());
    }
    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'Use GET or POST.' });
  } catch (err) {
    return send(res, err.status || 502, { error: err.message, code: err.code });
  }
};
