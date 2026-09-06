import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

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
            case 'purchase':
                if (method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleCreatePurchase(supabase, user, req, res);

            case 'list':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleListPurchases(supabase, user, req, res);

            case 'details':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleGetPurchaseDetails(supabase, user, req, res);

            default:
                return res.status(400).json({ success: false, error: 'Invalid action.' });
        }
    } catch (err) {
        console.error(`[API/PURCHASES] Error:`, err.message);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
}

/**
 * Handle creation of a new bulk purchase.
 * Uses the secure Database RPC for atomic transaction integrity.
 */
async function handleCreatePurchase(supabase, user, req, res) {
    const { product_id, quantity } = req.body;

    // 1. Basic Validation
    if (!product_id) return res.status(400).json({ success: false, error: 'Product ID is required.' });
    
    const qty = parseInt(quantity);
    if (isNaN(qty) || qty <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid quantity. Must be a positive integer.' });
    }

    // 2. Execute Atomic Purchase via RPC
    // This function (created in previous steps) handles:
    // - Locking the product row
    // - Validating inventory availability
    // - Validating purchase limits
    // - Deducting authoritative price from wallet
    // - Generating product_units
    // - Creating the wallet_transaction ledger entry
    const { data: purchaseId, error: rpcError } = await supabase.rpc('process_bulk_purchase', {
        p_user_id: user.id,
        p_product_id: product_id,
        p_quantity: qty
    });

    if (rpcError) {
        // Handle known business rule violations from SQL state
        let message = rpcError.message;
        if (message.includes('Insufficient wallet balance')) return res.status(402).json({ success: false, error: message });
        if (message.includes('Insufficient product inventory')) return res.status(409).json({ success: false, error: message });
        if (message.includes('exceeds product limit')) return res.status(400).json({ success: false, error: message });
        
        throw rpcError; // Re-throw to be caught by 500 handler
    }

    return res.status(201).json({
        success: true,
        message: 'Purchase completed successfully.',
        data: { purchase_id: purchaseId }
    });
}

/**
 * Handle listing the authenticated user's own purchases.
 */
async function handleListPurchases(supabase, user, req, res) {
    const { page = 1, limit = 10 } = req.query;

    const p = Math.max(1, parseInt(page));
    const l = Math.min(50, Math.max(1, parseInt(limit)));
    const from = (p - 1) * l;
    const to = from + l - 1;

    const { data, count, error } = await supabase
        .from('bulk_purchases')
        .select('*, products(name, category, image_url)', { count: 'exact' })
        .eq('user_id', user.id)
        .order('purchased_at', { ascending: false })
        .range(from, to);

    if (error) throw error;

    return res.status(200).json({
        success: true,
        data: data || [],
        pagination: {
            page: p,
            limit: l,
            total: count,
            total_pages: Math.ceil(count / l)
        }
    });
}

/**
 * Get details for a specific purchase owned by the user.
 */
async function handleGetPurchaseDetails(supabase, user, req, res) {
    const { id } = req.query;

    if (!id) return res.status(400).json({ success: false, error: 'Purchase ID is required.' });

    // Join with products and associated units
    const { data, error } = await supabase
        .from('bulk_purchases')
        .select('*, products(*), product_units(id, unit_code, status)')
        .eq('id', id)
        .eq('user_id', user.id)
        .single();

    if (error || !data) {
        return res.status(404).json({ success: false, error: 'Purchase record not found.' });
    }

    return res.status(200).json({
        success: true,
        data: data
    });
}
