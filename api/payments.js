import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
    const { method, query } = req;
    const action = query.action;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') return res.status(200).end();

    // 1. Authentication Check
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    // User-scoped client for RLS records
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return res.status(401).json({ success: false, error: 'Invalid session.' });
    }

    // Administrative client to read global settings safely
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    try {
        switch (action) {
            case 'deposit-instructions':
                return await handleGetDepositInstructions(adminClient, res);

            case 'deposit-request':
                if (method !== 'POST') return res.status(405).json({ success: false, error: 'POST required' });
                return await handleCreateDeposit(supabase, adminClient, user, req, res);

            case 'withdrawal-request':
                if (method !== 'POST') return res.status(405).json({ success: false, error: 'POST required' });
                return await handleCreateWithdrawal(supabase, user, req, res);

            case 'deposits':
                return await handleListDeposits(supabase, user, req, res);

            case 'withdrawals':
                return await handleListWithdrawals(supabase, user, req, res);

            default:
                return res.status(400).json({ success: false, error: 'Invalid action.' });
        }
    } catch (err) {
        console.error(`[API/PAYMENTS] Error:`, err.message);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
}

/**
 * Returns ZAP bank details and minimum deposit limits.
 */
async function handleGetDepositInstructions(adminClient, res) {
    const { data: settings } = await adminClient.from('settings').select('key, value');
    
    const minDep = settings.find(s => s.key === 'minimum_deposit')?.value || '3500';
    
    return res.status(200).json({
        success: true,
        data: {
            bank_name: "Fidelity Bank",
            account_name: "AMISU ELIJAH",
            account_number: "4580003805",
            currency: "NGN",
            currency_symbol: "₦",
            minimum_deposit: parseFloat(minDep)
        }
    });
}

/**
 * Record a new manual deposit request.
 */
async function handleCreateDeposit(supabase, adminClient, user, req, res) {
    const { amount, reference, proof_url } = req.body;

    // 1. Validation
    const { data: minDepSetting } = await adminClient.from('settings').select('value').eq('key', 'minimum_deposit').single();
    const minDeposit = parseFloat(minDepSetting?.value || '3500');

    const depAmount = parseFloat(amount);
    if (isNaN(depAmount) || depAmount < minDeposit) {
        return res.status(400).json({ success: false, error: `Minimum deposit is ₦${minDeposit.toLocaleString()}` });
    }

    if (!reference || reference.trim().length < 3) {
        return res.status(400).json({ success: false, error: 'A valid payment reference is required.' });
    }

    // 2. Persist Request (Status defaults to PENDING via Schema)
    const { data, error } = await supabase.from('deposits').insert({
        user_id: user.id,
        amount: depAmount,
        reference: reference.trim(),
        proof_url: proof_url || null,
        status: 'PENDING'
    }).select().single();

    if (error) {
        if (error.code === '23505') return res.status(409).json({ success: false, error: 'This payment reference has already been submitted.' });
        throw error;
    }

    return res.status(201).json({
        success: true,
        message: 'Deposit request submitted for review.',
        data: data
    });
}

/**
 * Handle withdrawal request via atomic RPC.
 */
async function handleCreateWithdrawal(supabase, user, req, res) {
    const { amount, bank_name, account_name, account_number } = req.body;

    // 1. Validation
    const withdrawAmount = parseFloat(amount);
    if (isNaN(withdrawAmount) || withdrawAmount <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid withdrawal amount.' });
    }

    if (!bank_name || !account_name || !account_number) {
        return res.status(400).json({ success: false, error: 'Complete bank payout details are required.' });
    }

    if (account_number.toString().length !== 10) {
        return res.status(400).json({ success: false, error: 'Nigerian account numbers must be 10 digits.' });
    }

    // 2. Call Atomic RPC (create_withdrawal_request)
    // This function handles settings lookup, fee calculation, 
    // balance checks, and fund reservation in one transaction.
    const { data: withdrawalId, error: rpcError } = await supabase.rpc('create_withdrawal_request', {
        p_amount: withdrawAmount,
        p_bank_name: bank_name.trim(),
        p_account_name: account_name.trim(),
        p_account_number: account_number.toString()
    });

    if (rpcError) {
        return res.status(400).json({ success: false, error: rpcError.message });
    }

    return res.status(201).json({
        success: true,
        message: 'Withdrawal request submitted. Funds reserved.',
        data: { withdrawal_id: withdrawalId }
    });
}

/**
 * List paginated deposits for the authenticated user.
 */
async function handleListDeposits(supabase, user, req, res) {
    const { page = 1, limit = 10 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    const { data, count, error } = await supabase
        .from('deposits')
        .select('*', { count: 'exact' })
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(from, to);

    if (error) throw error;

    return res.status(200).json({
        success: true,
        data,
        pagination: { total: count, page: parseInt(page) }
    });
}

/**
 * List paginated withdrawals for the authenticated user with account masking.
 */
async function handleListWithdrawals(supabase, user, req, res) {
    const { page = 1, limit = 10 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    const { data, count, error } = await supabase
        .from('withdrawals')
        .select('*', { count: 'exact' })
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .range(from, to);

    if (error) throw error;

    // Mask account numbers for transport
    const maskedData = data.map(w => ({
        ...w,
        account_number: `****${w.account_number.slice(-4)}`
    }));

    return res.status(200).json({
        success: true,
        data: maskedData,
        pagination: { total: count, page: parseInt(page) }
    });
}
