/**
 * A local stand-in for Numbers Gateway API v2.
 *
 * Purpose: exercise the real NumbersGatewayAdapter over real HTTP before any
 * sandbox credentials exist. It implements the documented contract — Basic
 * auth, decimal-dollar amounts, reference_number-keyed mutations, the
 * status/status_code response shape, and X-Signature webhooks — so a request
 * that satisfies this mock is a request shaped correctly for the real thing.
 *
 * It is NOT a simulator of the provider's behaviour and makes no claim to be:
 * it cannot tell you whether the gateway accepts a given card, only whether we
 * are speaking its language. Sandbox credentials remain the only way to learn
 * the former.
 *
 *   node scripts/mock-numbers-gateway.mjs [--port 4300] [--verbose]
 *
 * Outcomes are chosen by amount so a decline can be exercised deliberately:
 *   amount ending .11 → declined      .22 → pending (ACH-style)
 *   amount ending .33 → 500 error     anything else → approved
 */

import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';

const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 4300;
const verbose = args.includes('--verbose');

const WEBHOOK_SECRET = process.env.NUMBERS_WEBHOOK_SECRET ?? 'whsec_mock';

/** Every transaction this process has issued, by id. */
const transactions = new Map();
let nextId = 9000;
let nextReference = 500;

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
  if (verbose) console.log(`  ← ${status} ${payload}`);
};

/** Basic auth is the documented scheme; reject anything else outright. */
function authorised(req) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const [key, pin] = Buffer.from(header.slice(6), 'base64').toString().split(':');
  return Boolean(key && pin);
}

function outcomeFor(amount) {
  const cents = Math.round(Math.abs(amount) * 100) % 100;
  if (cents === 11) return 'declined';
  if (cents === 22) return 'pending';
  if (cents === 33) return 'error';
  return 'approved';
}

function buildTransaction(amount, outcome, type) {
  const id = nextId++;
  const referenceNumber = nextReference++;
  const lifecycle =
    outcome === 'approved' ? 'captured' : outcome === 'pending' ? 'originated' : 'declined';

  const record = {
    status: outcome === 'approved' ? 'Approved' : 'Declined',
    status_code: outcome === 'approved' ? 'A' : 'D',
    error_message: outcome === 'declined' ? 'card_declined: insufficient funds' : null,
    auth_amount: outcome === 'declined' ? 0 : amount,
    auth_code: outcome === 'approved' ? 'MOCK01' : null,
    reference_number: referenceNumber,
    transaction: {
      id,
      created_at: new Date().toISOString(),
      amount_details: { amount },
      transaction_details: { reference_number: referenceNumber, type },
      status_details: { status: lifecycle },
    },
  };

  transactions.set(String(id), record);
  transactions.set(`ref:${referenceNumber}`, record);
  return record;
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    const url = new URL(req.url, `http://localhost:${port}`);
    const path = url.pathname.replace(/^\/api\/v2/, '');

    if (verbose) console.log(`→ ${req.method} ${url.pathname}${raw ? ` ${raw}` : ''}`);

    if (!authorised(req)) {
      return json(res, 401, { error: 'Credentials are missing or invalid.' });
    }

    let body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: 'The request was invalid.' });
      }
    }

    // --- Charge ---
    if (req.method === 'POST' && path === '/transactions/charge') {
      if (typeof body.amount !== 'number') {
        return json(res, 400, { error: 'amount is required and must be a number' });
      }
      if (!body.source) {
        return json(res, 400, { error: 'source is required' });
      }
      const outcome = outcomeFor(body.amount);
      if (outcome === 'error') {
        return json(res, 500, { error: 'There was an error processing the transaction.' });
      }
      return json(res, 200, buildTransaction(body.amount, outcome, 'charge'));
    }

    // --- Mutations, all keyed by reference_number ---
    const mutation = ['capture', 'refund', 'void', 'reversal', 'adjust'].find(
      (name) => path === `/transactions/${name}`,
    );
    if (req.method === 'POST' && mutation) {
      const original = transactions.get(`ref:${body.reference_number}`);
      if (!original) {
        return json(res, 404, { error: `unknown reference_number ${body.reference_number}` });
      }
      const amount = body.amount ?? original.auth_amount;
      const record = buildTransaction(amount, outcomeFor(amount), mutation);
      if (mutation === 'void' || mutation === 'reversal') {
        record.transaction.status_details.status = 'voided';
      }
      return json(res, 200, record);
    }

    // --- Retrieve ---
    const retrieve = path.match(/^\/transactions\/(\d+)$/);
    if (req.method === 'GET' && retrieve) {
      const record = transactions.get(retrieve[1]);
      if (!record) return json(res, 404, { error: 'transaction not found' });
      return json(res, 200, record);
    }

    json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
  });
});

/**
 * Builds a webhook exactly as the provider would sign it, so the receiving end
 * can be tested without waiting on a real callback.
 */
export function signedWebhook(event) {
  const payload = JSON.stringify(event);
  return {
    body: payload,
    headers: {
      'content-type': 'application/json',
      'x-signature': createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex'),
    },
  };
}

server.listen(port, () => {
  console.log(`mock Numbers Gateway listening on http://localhost:${port}/api/v2`);
  console.log(`  amounts ending .11 decline, .22 pend, .33 error; all others approve`);
});
