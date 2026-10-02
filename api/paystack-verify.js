import { createClient } from '@supabase/supabase-js';
import { creditPaystackDeposit } from './paystack-webhook.js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ success: false, error: 'Invalid session' });

  const { reference } = req.body;
  if (!reference) return res.status(400).json({ success: false, error: 'reference is required' });

  try {
    const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { 'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
    });
    const paystackData = await paystackRes.json();

    if (!paystackData.status || !paystackData.data) {
      return res.status(400).json({ success: false, error: 'Could not verify this transaction with Paystack' });
    }

    const tx = paystackData.data;

    // Make sure this transaction actually belongs to the person asking —
    // never trust the reference alone as proof of ownership.
    if (tx.metadata?.user_id !== user.id) {
      return res.status(403).json({ success: false, error: 'This transaction does not belong to your account' });
    }

    if (tx.status !== 'success') {
      return res.status(200).json({ success: false, error: `Payment status: ${tx.status}`, status: tx.status });
    }

    const result = await creditPaystackDeposit(tx);
    return res.status(200).json({ success: true, amount: tx.amount / 100, ...result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
