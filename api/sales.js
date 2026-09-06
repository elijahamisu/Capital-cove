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
            case 'record':
                if (method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleRecordSale(supabase, user, req, res);

            case 'list':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleListSales(supabase, user, req, res);

            case 'summary':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleSalesSummary(supabase, user, req, res);

            case 'details':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleGetSaleDetails(supabase, user, req, res);

            default:
                return res.status(400).json({ success: false, error: 'Invalid action.' });
        }
    } catch (err) {
        console.error(`[API/SALES] Error:`, err.message);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
}

/**
 * Handle recording a new sale.
 * Uses the Database RPC to ensure unit ownership and atomic settlement.
 */
async function handleRecordSale(supabase, user, req, res) {
    const { product_unit_id, sale_amount } = req.body;

    // 1. Validation
    if (!product_unit_id) return res.status(400).json({ success: false, error: 'Product unit identifier is required.' });
    
    const amount = parseFloat(sale_amount);
    if (isNaN(amount) || amount <= 0) {
        return res.status(400).json({ success: false, error: 'Invalid sale amount. Must be greater than zero.' });
    }

    // 2. Call Atomic RPC Function
    // This function handles:
    // - Verification of ownership (unit.owner_id = user.id)
    // - Status check (must not be already SOLD)
    // - Update unit status to 'SOLD'
    // - Creation of 'sales' and 'settlements' records
    // - Immediate or queued wallet credit via ledger entry
    const { data: saleId, error: rpcError } = await supabase.rpc('record_product_sale', {
        p_unit_id: product_unit_id,
        p_sale_amount: amount
    });

    if (rpcError) {
        return res.status(400).json({ success: false, error: rpcError.message });
    }

    return res.status(201).json({
        success: true,
        message: 'Sale recorded and settlement processed.',
        data: { sale_id: saleId }
    });
}

/**
 * Handle listing authenticated user's own sales.
 */
async function handleListSales(supabase, user, req, res) {
    const { page = 1, limit = 15, status } = req.query;

    const p = Math.max(1, parseInt(page));
    const l = Math.min(50, Math.max(1, parseInt(limit)));
    const from = (p - 1) * l;
    const to = from + l - 1;

    let query = supabase
        .from('sales')
        .select('*, products(name), product_units(unit_code)', { count: 'exact' })
        .eq('seller_user_id', user.id);

    if (status) query = query.eq('status', status.toUpperCase());

    const { data, count, error } = await query
        .order('sold_at', { ascending: false })
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
 * Provide aggregate sales metrics for the user dashboard.
 */
async function handleSalesSummary(supabase, user, req, res) {
    const { data, error } = await supabase
        .from('sales')
        .select('sale_amount, net_amount, status')
        .eq('seller_user_id', user.id);

    if (error) throw error;

    const summary = {
        total_sales_count: data.length,
        completed_sales_count: data.filter(s => s.status === 'COMPLETED').length,
        gross_proceeds: data.reduce((acc, s) => acc + parseFloat(s.sale_amount), 0),
        net_proceeds: data.reduce((acc, s) => acc + parseFloat(s.net_amount), 0)
    };

    return res.status(200).json({
        success: true,
        data: summary
    });
}

/**
 * Get full details for a specific sale, including settlement status.
 */
async function handleGetSaleDetails(supabase, user, req, res) {
    const { id } = req.query;

    if (!id) return res.status(400).json({ success: false, error: 'Sale ID is required.' });

    const { data, error } = await supabase
        .from('sales')
        .select('*, products(name), product_units(unit_code), settlements(*)')
        .eq('id', id)
        .eq('seller_user_id', user.id)
        .single();

    if (error || !data) {
        return res.status(404).json({ success: false, error: 'Sale record not found.' });
    }

    return res.status(200).json({
        success: true,
        data: data
    });
}
