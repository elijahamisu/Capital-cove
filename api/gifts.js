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

    // Client for RLS-scoped data (History/Details)
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return res.status(401).json({ success: false, error: 'Invalid or expired session.' });
    }

    // Client with higher privileges for code validation (bypassing user-level restrictions)
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    try {
        switch (action) {
            case 'validate':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Use GET' });
                return await handleValidateCode(adminClient, user, req, res);

            case 'redeem':
                if (method !== 'POST') return res.status(405).json({ success: false, error: 'Use POST' });
                return await handleRedeemCode(adminClient, user, req, res);

            case 'history':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Use GET' });
                return await handleGetHistory(supabase, user, req, res);

            case 'detail':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Use GET' });
                return await handleGetDetail(supabase, user, req, res);

            default:
                return res.status(400).json({ success: false, error: 'Invalid action.' });
        }
    } catch (err) {
        console.error(`[API/GIFTS] Error:`, err.message);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
}

/**
 * Check if a code is valid/available without redeeming it.
 */
async function handleValidateCode(adminClient, user, req, res) {
    const code = req.query.code?.trim().toUpperCase();
    if (!code) return res.status(400).json({ success: false, error: 'Gift code is required.' });

    const { data, error } = await adminClient
        .from('gift_codes')
        .select('id, code, reward_amount, status, expires_at, used_count, usage_limit')
        .eq('code', code)
        .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Invalid gift code.' });

    // Check availability
    const isExpired = data.expires_at && new Date(data.expires_at) < new Date();
    const isExhausted = data.used_count >= data.usage_limit;
    const isActive = data.status === 'ACTIVE';

    if (!isActive || isExpired || isExhausted) {
        return res.status(200).json({ success: false, error: 'This gift code is no longer valid or has expired.' });
    }

    // Check if user already redeemed
    const { data: existing } = await adminClient
        .from('gift_code_redemptions')
        .select('id')
        .eq('gift_code_id', data.id)
        .eq('user_id', user.id)
        .single();

    if (existing) {
        return res.status(200).json({ success: false, error: 'You have already redeemed this gift code.' });
    }

    return res.status(200).json({
        success: true,
        data: {
            reward_amount: data.reward_amount,
            currency: 'NGN'
        }
    });
}

/**
 * Perform Atomic Redemption via RPC.
 */
async function handleRedeemCode(adminClient, user, req, res) {
    const { code } = req.body;
    if (!code || code.trim() === '') {
        return res.status(400).json({ success: false, error: 'Gift code is required.' });
    }

    const normalizedCode = code.trim().toUpperCase();

    // Call Database RPC: redeem_gift_code(p_user_id, p_code)
    // This function ensures the transaction is atomic.
    const { data, error } = await adminClient.rpc('redeem_gift_code', {
        p_user_id: user.id,
        p_code: normalizedCode
    });

    if (error) {
        return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
        success: true,
        message: 'Gift code redeemed successfully. Reward added to wallet.',
        data: {
            reward_amount: data.reward_amount,
            reference: data.reference
        }
    });
}

/**
 * Get authenticated user's own redemption history.
 */
async function handleGetHistory(supabase, user, req, res) {
    const { page = 1, limit = 10 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    const { data, count, error } = await supabase
        .from('gift_code_redemptions')
        .select(`
            id, 
            redeemed_at, 
            gift_codes (
                code, 
                reward_amount
            )
        `, { count: 'exact' })
        .eq('user_id', user.id)
        .order('redeemed_at', { ascending: false })
        .range(from, to);

    if (error) throw error;

    return res.status(200).json({
        success: true,
        data: data || [],
        pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: count
        }
    });
}

/**
 * Get details for a specific redemption owned by the user.
 */
async function handleGetDetail(supabase, user, req, res) {
    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, error: 'Redemption ID required.' });

    const { data, error } = await supabase
        .from('gift_code_redemptions')
        .select(`
            id, 
            redeemed_at, 
            gift_codes (code, reward_amount)
        `)
        .eq('id', id)
        .eq('user_id', user.id) // Security: Check ownership
        .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Redemption record not found.' });

    return res.status(200).json({
        success: true,
        data
    });
}
