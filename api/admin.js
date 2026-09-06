import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Use Service Role client for administrative bypass of RLS where necessary
const adminClient = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
    const { method, query } = req;
    const action = query.action;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') return res.status(200).end();

    // 1. Mandatory Admin Authorization Check
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'Authentication token missing' });

    // Verify user session
    const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ success: false, error: 'Invalid session' });

    // Verify Admin Table Authorization
    const { data: adminUser, error: adminCheckError } = await adminClient
        .from('admin_users')
        .select('role')
        .eq('id', user.id)
        .single();

    if (adminCheckError || !adminUser) {
        return res.status(403).json({ success: false, error: 'Access denied. Administrator privileges required.' });
    }

    try {
        switch (action) {
            // --- USER MANAGEMENT ---
            case 'get-users':
                return await handleGetUsers(req, res);
            case 'get-user-details':
                return await handleGetUserDetails(req, res);
            case 'update-user-status':
                return await handleUpdateUserStatus(user.id, req, res);

            // --- PRODUCT & INVENTORY ---
            case 'manage-product':
                return await handleManageProduct(user.id, req, res);
            case 'get-inventory':
                return await handleGetInventory(req, res);

            // --- FINANCIAL OPS (RPC-driven for atomicity) ---
            case 'process-deposit':
                return await handleProcessDeposit(user.id, req, res);
            case 'process-withdrawal':
                return await handleProcessWithdrawal(user.id, req, res);

            // --- SYSTEM & LOGS ---
            case 'update-settings':
                return await handleUpdateSettings(user.id, req, res);
            case 'get-admin-logs':
                return await handleGetAdminLogs(req, res);

            default:
                return res.status(400).json({ success: false, error: 'Invalid admin action.' });
        }
    } catch (err) {
        console.error(`[ADMIN_API] Global Error:`, err.message);
        return res.status(500).json({ success: false, error: 'Internal server error.' });
    }
}

/**
 * Audit Logger Helper
 */
async function logAdminAction(adminId, action, targetId, details = {}) {
    await adminClient.from('admin_logs').insert({
        admin_id: adminId,
        action: action,
        target_id: targetId?.toString(),
        details: details
    });
}

// --- HANDLERS ---

async function handleGetUsers(req, res) {
    const { page = 1, limit = 20, search, status } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    let query = adminClient.from('profiles').select('*', { count: 'exact' });
    if (status && status !== 'all') query = query.eq('status', status);
    if (search) query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%,referral_code.ilike.%${search}%`);

    const { data, count, error } = await query.order('created_at', { ascending: false }).range(from, to);
    if (error) throw error;
    return res.status(200).json({ success: true, data, pagination: { total: count, page: parseInt(page) } });
}

async function handleGetUserDetails(req, res) {
    const { id } = req.query;
    if (!id) return res.status(400).json({ success: false, error: 'User ID required' });

    // Parallel fetch for user context
    const [profile, wallet, purchases, sales] = await Promise.all([
        adminClient.from('profiles').select('*').eq('id', id).single(),
        adminClient.from('wallets').select('*').eq('user_id', id).single(),
        adminClient.from('bulk_purchases').select('*, products(name)').eq('user_id', id),
        adminClient.from('sales').select('*, products(name)').eq('seller_user_id', id)
    ]);

    return res.status(200).json({
        success: true,
        data: {
            profile: profile.data,
            wallet: wallet.data,
            purchases: purchases.data,
            sales: sales.data
        }
    });
}

async function handleUpdateUserStatus(adminId, req, res) {
    const { user_id, status } = req.body;
    const allowedStatuses = ['ACTIVE', 'SUSPENDED', 'RESTRICTED'];
    
    if (!allowedStatuses.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status' });

    const { error } = await adminClient.from('profiles').update({ status, updated_at: new Date() }).eq('id', user_id);
    if (error) throw error;

    await logAdminAction(adminId, 'USER_STATUS_CHANGE', user_id, { new_status: status });
    return res.status(200).json({ success: true, message: `User status updated to ${status}` });
}

async function handleManageProduct(adminId, req, res) {
    const { method } = req;
    const { id, ...productData } = req.body;

    if (method === 'POST') { // Create
        const { data, error } = await adminClient.from('products').insert([productData]).select().single();
        if (error) throw error;
        await logAdminAction(adminId, 'PRODUCT_CREATED', data.id, { name: data.name });
        return res.status(201).json({ success: true, data });
    } 
    
    if (method === 'PATCH') { // Update
        const { data, error } = await adminClient.from('products').update(productData).eq('id', id).select().single();
        if (error) throw error;
        await logAdminAction(adminId, 'PRODUCT_UPDATED', id, { changes: productData });
        return res.status(200).json({ success: true, data });
    }

    return res.status(405).json({ success: false, error: 'Method not allowed for products' });
}

async function handleProcessDeposit(adminId, req, res) {
    const { deposit_id, action, reason } = req.body; // action: 'approve' | 'reject'

    if (action === 'approve') {
        const { error } = await adminClient.rpc('approve_deposit', { p_deposit_id: deposit_id, p_admin_id: adminId });
        if (error) return res.status(400).json({ success: false, error: error.message });
    } else {
        const { error } = await adminClient.rpc('reject_deposit', { p_deposit_id: deposit_id, p_admin_id: adminId, p_reason: reason });
        if (error) return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({ success: true, message: `Deposit ${action}ed successfully` });
}

async function handleProcessWithdrawal(adminId, req, res) {
    const { withdrawal_id, action, reason } = req.body; // action: 'complete' | 'reject'

    if (action === 'complete') {
        const { error } = await adminClient.rpc('admin_complete_withdrawal', { p_withdrawal_id: withdrawal_id, p_admin_id: adminId });
        if (error) return res.status(400).json({ success: false, error: error.message });
    } else {
        const { error } = await adminClient.rpc('admin_reject_withdrawal', { p_withdrawal_id: withdrawal_id, p_admin_id: adminId, p_reason: reason });
        if (error) return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({ success: true, message: `Withdrawal ${action}ed successfully` });
}

async function handleUpdateSettings(adminId, req, res) {
    const { settings } = req.body; // Array of {key, value}
    const allowlist = ['minimum_deposit', 'minimum_withdrawal', 'withdrawal_charge_percent', 'referral_bonus_percent', 'platform_name'];

    const validUpdates = settings.filter(s => allowlist.includes(s.key));
    
    const { error } = await adminClient.from('settings').upsert(validUpdates);
    if (error) throw error;

    await logAdminAction(adminId, 'SETTINGS_UPDATED', 'SYSTEM', { keys: validUpdates.map(v => v.key) });
    return res.status(200).json({ success: true, message: 'Settings updated successfully' });
}

async function handleGetAdminLogs(req, res) {
    const { page = 1, limit = 50 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to = from + parseInt(limit) - 1;

    const { data, count, error } = await adminClient
        .from('admin_logs')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(from, to);

    if (error) throw error;
    return res.status(200).json({ success: true, data, pagination: { total: count } });
}
