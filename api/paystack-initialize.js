import { createClient } from '@supabase/supabase-js';

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

  const { amount } = req.body;
  const numAmount = Number(amount);
  if (!numAmount || numAmount <= 0) return res.status(400).json({ success: false, error: 'A valid amount is required' });

  try {
    const { data: minSetting } = await supabase.from('settings').select('value').eq('key', 'minimum_deposit').single();
    const minDeposit = Number(minSetting?.value) || 0;
    if (numAmount < minDeposit) {
      return res.status(400).json({ success: false, error: `Minimum deposit is ₦${minDeposit}` });
    }

    const reference = `PSK-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email: user.email,
        amount: Math.round(numAmount * 100), // Paystack expects kobo
        reference,
        callback_url: `${req.headers.origin || 'https://' + req.headers.host}/deposit.html?paystack_ref=${reference}`,
        metadata: { user_id: user.id }
      })
    });

    const paystackData = await paystackRes.json();
    if (!paystackData.status) {
      return res.status(400).json({ success: false, error: paystackData.message || 'Could not start payment with Paystack' });
    }

    return res.status(200).json({
      success: true,
      authorization_url: paystackData.data.authorization_url,
      reference
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
