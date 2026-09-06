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
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') return res.status(200).end();

    // 1. HTTP Method Enforcement (Read-only API for normal users)
    if (method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed. GET required.' });
    }

    // 2. Authentication Check
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) {
        return res.status(401).json({ success: false, error: 'Authentication required.' });
    }

    // User client for RLS records
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return res.status(401).json({ success: false, error: 'Invalid session.' });
    }

    // Service Role client for multi-level hierarchy lookups that cross user boundaries
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);

    try {
        switch (action) {
            case 'code':
                return await handleGetReferralCode(supabase, user, res);

            case 'stats':
                return await handleGetReferralStats(adminClient, user, res);

            case 'list':
                return await handleListReferrals(adminClient, user, req, res);

            case 'commissions':
                return await handleGetCommissions(supabase, user, req, res);

            default:
                return res.status(400).json({ success: false, error: 'Invalid action.' });
        }
    } catch (err) {
        console.error(`[API/REFERRALS] Error:`, err.message);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
}

/**
 * Retrieve the user's authoritative referral code from their profile.
 */
async function handleGetReferralCode(supabase, user, res) {
    const { data, error } = await supabase
        .from('profiles')
        .select('referral_code')
        .eq('id', user.id)
        .single();

    if (error || !data) return res.status(404).json({ success: false, error: 'Referral code not found.' });

    return res.status(200).json({
        success: true,
        data: { referral_code: data.referral_code }
    });
}

/**
 * Calculate real statistics for Level 1 (Direct) and Level 2 (Indirect) referrals.
 */
async function handleGetReferralStats(adminClient, user, res) {
    // 1. Get Level 1 (Users directly referred by current user)
    const { data: level1Users, error: l1Error } = await adminClient
        .from('profiles')
        .select('id')
        .eq('referred_by', user.id);

    if (l1Error) throw l1Error;

    const level1Count = level1Users.length;
    let level2Count = 0;

    // 2. Get Level 2 (Users referred by those in Level 1)
    if (level1Count > 0) {
        const l1Ids = level1Users.map(u => u.id);
        const { count, error: l2Error } = await adminClient
            .from('profiles')
            .select('id', { count: 'exact', head: true })
            .in('referred_by', l1Ids);
        
        if (l2Error) throw l2Error;
        level2Count = count || 0;
    }

    // 3. Get commission totals from the referrals ledger
    const { data: comms, error: cError } = await adminClient
        .from('referrals')
        .select('commission_amount, status')
        .eq('referrer_id', user.id);

    if (cError) throw cError;

    const qualifiedCount = comms.filter(r => r.status === 'QUALIFIED').length;
    const totalEarned = comms.reduce((acc, r) => acc + (parseFloat(r.commission_amount) || 0), 0);

    return res.status(200).json({
        success: true,
        data: {
            level_1_count: level1Count,
            level_2_count: level2Count,
            total_referrals: level1Count + level2Count,
            qualified_count: qualifiedCount,
            total_commission_earned: totalEarned
        }
    });
}

/**
 * List the user's direct referrals with privacy masking.
 */
async function handleListReferrals(adminClient, user, req, res) {
    const { page = 1, limit = 20 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    const { data, count, error } = await adminClient
        .from('profiles')
        .select('full_name, created_at', { count: 'exact' })
        .eq('referred_by', user.id)
        .order('created_at', { ascending: false })
        .range(from, to);

    if (error) throw error;

    // Mask for privacy: "John Doe" -> "John D."
    const maskedData = data.map(u => {
        const parts = u.full_name?.split(' ') || ['User'];
        const maskedName = parts.length > 1 ? `${parts[0]} ${parts[1][0]}.` : parts[0];
        return {
            name: maskedName,
            joined_at: u.created_at
        };
    });

    return res.status(200).json({
        success: true,
        data: maskedData,
        pagination: { total: count, page: parseInt(page) }
    });
}

/**
 * Retrieve real commission records from the authoritative ledger.
 */
async function handleGetCommissions(supabase, user, req, res) {
    const { data, error } = await supabase
        .from('referrals')
        .select('id, commission_amount, status, created_at')
        .eq('referrer_id', user.id)
        .gt('commission_amount', 0) // Only records where money was recorded
        .order('created_at', { ascending: false });

    if (error) throw error;

    return res.status(200).json({
        success: true,
        data: data || []
    });
}
