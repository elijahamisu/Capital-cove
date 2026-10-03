import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Vercel needs the raw request body to verify Paystack's signature correctly.
export const config = {
  api: {
    bodyParser: false
  }
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);

  // Verify this request genuinely came from Paystack, not a spoofed call.
  const signature = req.headers['x-paystack-signature'];
  const expectedSignature = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(rawBody)
    .digest('hex');

  if (signature !== expectedSignature) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody.toString());

  if (event.event === 'charge.success') {
    try {
      await creditPaystackDeposit(event.data);
    } catch (err) {
      console.error('Paystack webhook credit error:', err.message);
      // Still return 200 so Paystack doesn't endlessly retry a permanently
      // failing event; the error is logged for manual investigation.
    }
  }

  return res.status(200).json({ received: true });
}

// Shared, idempotent crediting logic — safe to call from both the webhook
// and the browser-side verify endpoint without ever double-crediting,
// since `deposits.reference` has a unique constraint.
export async function creditPaystackDeposit(paystackData) {
  const { reference, amount, customer, metadata, status } = paystackData;
  if (status !== 'success') return { credited: false, reason: 'not successful' };

  const userId = metadata?.user_id;
  if (!userId) throw new Error('Missing user_id in payment metadata');

  const depositAmount = amount / 100; // convert from kobo back to naira

  const { data: existing } = await supabase
    .from('deposits')
    .select('id')
    .eq('reference', reference)
    .maybeSingle();

  if (existing) return { credited: false, reason: 'already processed' };

  const { data: deposit, error: depositError } = await supabase
    .from('deposits')
    .insert({
      user_id: userId,
      amount: depositAmount,
      reference,
      status: 'APPROVED',
      payer_bank_name: 'Paystack',
      payer_account_name: customer?.email || 'Card Payment',
      reviewed_at: new Date()
    })
    .select()
    .single();

  // A unique constraint violation here means another process (webhook and
  // browser verify racing each other) already inserted this reference —
  // that's fine, just treat it as already credited.
  if (depositError) {
    if (depositError.code === '23505') return { credited: false, reason: 'already processed (race)' };
    throw depositError;
  }

  const { error: creditError } = await supabase.rpc('adjust_wallet_balance', {
    p_user_id: userId,
    p_amount: depositAmount,
    p_type: 'DEPOSIT',
    p_reference: deposit.id,
    p_description: `Instant deposit via Paystack (${reference})`
  });
  if (creditError) throw creditError;

  // Referral commissions are tied to Paystack deposits — this is the only
  // deposit path now that manual bank transfers have been removed.
  const { error: commissionError } = await supabase.rpc('process_referral_commissions', {
    p_depositor_id: userId,
    p_deposit_amount: depositAmount,
    p_reference_id: deposit.id
  });
  if (commissionError) {
    // Don't fail the whole deposit over a commission-processing issue —
    // the depositor's own funds are already safely credited above.
    console.error('Referral commission processing failed:', commissionError.message);
  }

  return { credited: true, amount: depositAmount };
}
