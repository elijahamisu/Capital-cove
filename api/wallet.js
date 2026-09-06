import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
    const { method, query } = req;
    const action = query.action;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') return res.status(200).end();

    // 1. HTTP Method Enforcement (Read-only API)
    if (method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed. This API is read-only.' });
    }

    // 2. Authentication Check
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    // Initialize Supabase with user context to respect RLS
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
    }

    try {
        switch (action) {
            case 'balance':
                return await handleGetBalance(supabase, user, res);

            case 'transactions':
                return await handleGetTransactions(supabase, user, req, res);

            case 'transaction':
                return await handleGetTransactionDetail(supabase, user, req, res);

            case 'summary':
                return await handleGetWalletSummary(supabase, user, res);

            default:
                return res.status(400).json({ success: false, error: 'Invalid action.' });
        }
    } catch (err) {
        console.error(`[API/WALLET] Error:`, err.message);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
}

/**
 * Retrieve the current authoritative wallet balance.
 */
async function handleGetBalance(supabase, user, res) {
    const { data, error } = await supabase
        .from('wallets')
        .select('id, available_balance, pending_balance, updated_at')
        .eq('user_id', user.id)
        .single();

    if (error || !data) {
        return res.status(404).json({ success: false, error: 'Wallet not found.' });
    }

    return res.status(200).json({
        success: true,
        data: {
            ...data,
            currency: 'NGN',
            currency_symbol: '₦'
        }
    });
}

/**
 * Retrieve a paginated list of transaction ledger entries.
 */
async function handleGetTransactions(supabase, user, req, res) {
    const { 
        page = 1, 
        limit = 20, 
        type, 
        status, 
        sort = 'created_at', 
        direction = 'desc' 
    } = req.query;

    // Sanitize and Paginate
    const p = Math.max(1, parseInt(page));
    const l = Math.min(100, Math.max(1, parseInt(limit)));
    const from = (p - 1) * l;
    const to = from + l - 1;

    let query = supabase
        .from('wallet_transactions')
        .select('*', { count: 'exact' })
        .eq('user_id', user.id);

    // Apply Filters (Allowlist)
    if (type) {
        const allowedTypes = ['DEPOSIT', 'BULK_PURCHASE', 'SALE_PROCEEDS', 'WITHDRAWAL', 'WITHDRAWAL_FEE', 'REFERRAL_BONUS', 'GIFT_CODE', 'REFUND', 'ADMIN_ADJUSTMENT'];
        if (allowedTypes.includes(type.toUpperCase())) {
            query = query.eq('type', type.toUpperCase());
        }
    }

    if (status) {
        query = query.eq('status', status);
    }

    // Safe Sorting
    const allowedSorts = ['created_at', 'amount', 'type'];
    const sField = allowedSorts.includes(sort) ? sort : 'created_at';
    const sDir = direction.toLowerCase() === 'asc' ? true : false;
    
    query = query.order(sField, { ascending: sDir });

    const { data, count, error } = await query.range(from, to);

    if (error) throw error;

    return res.status(200).json({
        success: true,
        data: data || [],
        pagination: {
            page: p,
            limit: l,
            total: count,
            total_pages: Math.ceil(count / l),
            has_next: to < count - 1
        }
    });
}

/**
 * Retrieve a single transaction with full detail.
 */
async function handleGetTransactionDetail(supabase, user, req, res) {
    const { id } = req.query;

    if (!id) return res.status(400).json({ success: false, error: 'Transaction ID is required.' });

    const { data, error } = await supabase
        .from('wallet_transactions')
        .select('*')
        .eq('id', id)
        .eq('user_id', user.id) // Strict ownership check
        .single();

    if (error || !data) {
        return res.status(404).json({ success: false, error: 'Transaction not found.' });
    }

    return res.status(200).json({
        success: true,
        data: data
    });
}

/**
 * Provide a high-level aggregate summary of wallet activity.
 */
async function handleGetWalletSummary(supabase, user, res) {
    const { data, error } = await supabase
        .from('wallet_transactions')
        .select('type, amount')
        .eq('user_id', user.id);

    if (error) throw error;

    const summary = {
        total_credits: 0,
        total_debits: 0,
        transaction_count: data.length
    };

    data.forEach(tx => {
        const amt = parseFloat(tx.amount);
        if (amt > 0) summary.total_credits += amt;
        else summary.total_debits += Math.abs(amt);
    });

    return res.status(200).json({
        success: true,
        data: summary
    });
}
