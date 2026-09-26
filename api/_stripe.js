// Stripe helpers shared by the server functions (files starting with _ aren't routes on Vercel).
// Uses Stripe's REST API directly, so there are no packages to install.
//
// Settings (Vercel → Settings → Environment Variables):
//   STRIPE_SECRET_KEY       sk_test_… / sk_live_…  (payments are off until this is set)
//   STRIPE_PUBLISHABLE_KEY  pk_test_… / pk_live_…
//   PRICE_CENTS             price per model in cents (default 299)
//   PRICE_CURRENCY          default usd

const API = 'https://api.stripe.com/v1';
const USES_PER_PAYMENT = 2; // one model, plus one retry if the first attempt fails

const enabled = () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PUBLISHABLE_KEY);
const price = () => ({
  cents: parseInt(process.env.PRICE_CENTS || '299', 10),
  currency: (process.env.PRICE_CURRENCY || 'usd').toLowerCase(),
});

// Nested objects -> Stripe's form encoding (a[b][0][c]=…).
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(path, { method = 'GET', body } = {}) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      // Pinned, so the account's default API version can't change how these requests behave.
      'Stripe-Version': '2024-06-20',
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body ? form(body).toString() : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error('Stripe', r.status, JSON.stringify(data.error || data).slice(0, 500));
    const err = new Error('The payment service had a problem. Please try again.');
    err.status = 502;
    // Stripe's error code (e.g. a missing key permission) for the browser console; never the message or key.
    err.code = (data.error && (data.error.code || data.error.type)) || `http_${r.status}`;
    throw err;
  }
  return data;
}

// An embedded Checkout session for one model. The page mounts it with Stripe.js; nothing redirects.
async function createCheckout() {
  const { cents, currency } = price();
  const session = await stripe('/checkout/sessions', {
    method: 'POST',
    body: {
      mode: 'payment',
      ui_mode: 'embedded',
      redirect_on_completion: 'never',
      line_items: [{
        quantity: 1,
        price_data: {
          currency,
          unit_amount: cents,
          product_data: {
            name: 'Legofy: one model',
            description: 'Your 3D model, the brick build, printable instructions, build video and parts list.',
          },
        },
      }],
      metadata: { product: 'legofy-model' },
      payment_intent_data: { metadata: { product: 'legofy-model', uses: 0 } },
    },
  });
  return { id: session.id, clientSecret: session.client_secret };
}

// Is this Checkout session paid, and how many times has it been used? Returns
// { paid, uses, left, paymentIntent }.
async function checkPayment(sessionId) {
  if (typeof sessionId !== 'string' || !/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) return { paid: false };
  const s = await stripe(`/checkout/sessions/${sessionId}?expand[]=payment_intent`);
  const pi = s.payment_intent;
  const paid = s.status === 'complete' && s.payment_status === 'paid' && pi && typeof pi === 'object' &&
    (s.metadata || {}).product === 'legofy-model';
  if (!paid) return { paid: false };
  const uses = parseInt((pi.metadata || {}).uses || '0', 10);
  return { paid: true, uses, left: Math.max(0, USES_PER_PAYMENT - uses), paymentIntent: pi.id };
}

// Count one use of a payment (stored on the payment in Stripe, so no database is needed).
async function useOnce(check, note) {
  await stripe(`/payment_intents/${check.paymentIntent}`, {
    method: 'POST',
    body: { metadata: { uses: check.uses + 1, [`use_${check.uses + 1}`]: note } },
  });
}

module.exports = { enabled, price, createCheckout, checkPayment, useOnce };
