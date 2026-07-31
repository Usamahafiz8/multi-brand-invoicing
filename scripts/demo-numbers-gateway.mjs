/**
 * Drives the real NumbersGatewayAdapter against the local mock, over real HTTP.
 *
 * This is the credential-free proof that the integration is wired correctly:
 * the adapter under test is the same class production uses, the transport is
 * genuine fetch, and every field on the wire is the field the provider's
 * documentation specifies. What it cannot prove is how the real gateway
 * behaves — only sandbox credentials can do that.
 *
 *   node scripts/mock-numbers-gateway.mjs --port 4300 &
 *   node scripts/demo-numbers-gateway.mjs
 *
 * Requires apps/api to have been built (pnpm --filter @fenwick/api build).
 */

import { createHmac } from 'node:crypto';

const BASE_URL = process.env.MOCK_BASE_URL ?? 'http://localhost:4300/api/v2';
const WEBHOOK_SECRET = 'whsec_mock';

const { NumbersGatewayAdapter } = await import(
  '../apps/api/dist/adapters/gateway/numbers-gateway.adapter.js'
);

const env = {
  NUMBERS_API_BASE_URL: BASE_URL,
  NUMBERS_API_KEY: 'src_demo_key',
  NUMBERS_API_KEY_PIN: '4242',
  NUMBERS_WEBHOOK_SECRET: WEBHOOK_SECRET,
};

const gateway = new NumbersGatewayAdapter(env);

const heading = (text) => console.log(`\n\x1b[1m${text}\x1b[0m`);
const show = (label, value) => console.log(`  ${label}:`, value);

function intentInput(overrides = {}) {
  return {
    idempotencyKey: `demo-${Math.trunc(performance.now() * 1000)}`,
    invoiceId: 'inv-demo-1',
    brandId: 'brand-demo',
    amountMinor: 46_800,
    currency: 'USD',
    method: 'CARD',
    description: 'Invoice INV-DEMO',
    customer: { email: 'payer@example.com', name: 'Jane Payer' },
    returnUrl: 'http://localhost:3001/i/demo',
    source: { kind: 'NONCE', token: 'ntok_demo_abc', expiryMonth: 12, expiryYear: 2030 },
    ...overrides,
  };
}

heading('1. Charge a card via a hosted-tokenization nonce');
const approved = await gateway.createIntent(intentInput());
show('status', approved.status);
show('gatewayReference', approved.gatewayReference);
show('amountMinor', `${approved.amountMinor} (from the gateway's authorised amount)`);

heading('2. Repeat the same idempotency key');
const repeat = await gateway.createIntent({ ...intentInput(), idempotencyKey: 'demo-fixed' });
const repeatAgain = await gateway.createIntent({ ...intentInput(), idempotencyKey: 'demo-fixed' });
show('same reference returned', repeat.gatewayReference === repeatAgain.gatewayReference);
show('note', 'the gateway has no idempotency key — this dedupe is ours alone');

heading('3. A decline is reported, not thrown');
const declined = await gateway.createIntent(intentInput({ amountMinor: 46_811 }));
show('status', declined.status);
show('declineReason', declined.declineReason);

heading('4. Refund the approved charge');
const refund = await gateway.refund({
  gatewayReference: approved.gatewayReference,
  amountMinor: 10_000,
  idempotencyKey: 'demo-refund',
});
show('status', refund.status);
show('amountMinor', refund.amountMinor);
show('refundReference', refund.refundReference);

heading('5. Void the charge');
const voided = await gateway.void(approved.gatewayReference);
show('status', voided.status);

heading('6. Retrieve it again');
const retrieved = await gateway.retrieve(approved.gatewayReference);
show('status', retrieved.status);
show('amountMinor', retrieved.amountMinor);

heading('7. A 5xx on a charge is INDETERMINATE, never retryable');
try {
  await gateway.createIntent(intentInput({ amountMinor: 46_833 }));
  console.log('  UNEXPECTED: the call should not have succeeded');
} catch (error) {
  show('errorClass', error.errorClass);
  show('retryable', error.retryable);
  show('why', 'replaying a charge with no idempotency key can bill the customer twice');
}

heading('8. Webhook signature verification');
const event = {
  type: 'succeeded',
  subType: 'charge',
  event: 'transaction',
  id: 'evt_demo_1',
  timestamp: new Date().toISOString(),
  data: { auth_amount: 468, transaction: { id: Number(approved.gatewayReference) } },
};
const body = JSON.stringify(event);
const signature = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');

show('valid signature accepted', gateway.verifySignature(body, { 'x-signature': signature }));
show('tampered body rejected', gateway.verifySignature(`${body} `, { 'x-signature': signature }));
show('unsigned probe rejected', gateway.verifySignature(body, {}));

const parsed = gateway.parseWebhook(body);
show('parsed type', parsed.type);
show('parsed reference', parsed.gatewayReference);
show('parsed amountMinor', parsed.amountMinor);

heading('9. ACH settles asynchronously — a status event drives the lifecycle');
for (const subType of ['originated', 'settled', 'returned']) {
  const statusEvent = JSON.stringify({
    type: 'status',
    subType,
    event: 'transaction',
    id: `evt_${subType}`,
    data: { id: 9001 },
  });
  show(subType, gateway.parseWebhook(statusEvent).type);
}

console.log('\n\x1b[32mAll steps completed against the mock gateway.\x1b[0m');
console.log('No credentials were used, and no invoice in your database was touched.\n');
