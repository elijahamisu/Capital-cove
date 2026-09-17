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
            case 'delete-user':
                return await handleDeleteUser(user.id, req, res);
            case 'assign-product':
                return await handleAssignProduct(user.id, req, res);
            case 'remove-product':
                return await handleRemoveProduct(user.id, req, res);
            case 'delete-unit':
                return await handleDeleteUnit(user.id, req, res);
            case 'adjust-wallet':
                return await handleAdjustWallet(user.id, req, res);

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

async function handleDeleteUser(adminId, req, res) {
    const { user_id } = req.body;
    if (!user_id) return res.status(400).json({ success: false, error: 'User ID required' });
    if (user_id === adminId) return res.status(400).json({ success: false, error: 'You cannot delete your own admin account here.' });

    const { error } = await adminClient.auth.admin.deleteUser(user_id);
    if (error) {
        // Most likely cause: foreign key constraints from related financial
        // records (wallet_transactions, sales, deposits, etc.) blocking deletion.
        return res.status(400).json({ success: false, error: `Could not delete user: ${error.message}. They likely have existing transaction/order history that must be handled first — consider suspending the account instead.` });
    }

    // Best-effort cleanup in case profiles isn't set to cascade-delete
    await adminClient.from('profiles').delete().eq('id', user_id);

    await logAdminAction(adminId, 'USER_DELETED', user_id, {});
    return res.status(200).json({ success: true, message: 'User deleted successfully' });
}

async function handleRemoveProduct(adminId, req, res) {
    const { user_id, product_id, quantity } = req.body;
    const qty = parseInt(quantity);
    if (!user_id || !product_id || !qty || qty < 1) {
        return res.status(400).json({ success: false, error: 'user_id, product_id and a positive quantity are required' });
    }

    const { data: product, error: productError } = await adminClient.from('products').select('*').eq('id', product_id).single();
    if (productError || !product) return res.status(404).json({ success: false, error: 'Product not found' });

    const unitsToRemove = product.units_per_bulk * qty;

    // Prefer removing non-sold units first (less destructive); only reach
    // into sold units if there aren't enough non-sold ones to make up the count.
    const { data: nonSoldUnits, error: nonSoldError } = await adminClient
        .from('product_units')
        .select('id, status')
        .eq('owner_id', user_id)
        .eq('product_id', product_id)
        .neq('status', 'SOLD')
        .limit(unitsToRemove);
    if (nonSoldError) throw nonSoldError;

    let unitsToDelete = nonSoldUnits || [];
    const stillNeeded = unitsToRemove - unitsToDelete.length;

    if (stillNeeded > 0) {
        const { data: soldUnits, error: soldError } = await adminClient
            .from('product_units')
            .select('id, status')
            .eq('owner_id', user_id)
            .eq('product_id', product_id)
            .eq('status', 'SOLD')
            .limit(stillNeeded);
        if (soldError) throw soldError;
        unitsToDelete = unitsToDelete.concat(soldUnits || []);
    }

    if (unitsToDelete.length < unitsToRemove) {
        return res.status(400).json({ success: false, error: `User only owns ${unitsToDelete.length} unit(s) of this product in total — need ${unitsToRemove} to remove ${qty} bulk package(s).` });
    }

    const soldIdsBeingRemoved = unitsToDelete.filter(u => u.status === 'SOLD').map(u => u.id);
    if (soldIdsBeingRemoved.length) {
        // Cascade-delete linked sales/settlements for any sold units being force-removed.
        // Wallet proceeds already paid out are intentionally left untouched.
        const { data: relatedSales } = await adminClient.from('sales').select('id').in('product_unit_id', soldIdsBeingRemoved);
        if (relatedSales?.length) {
            const saleIds = relatedSales.map(s => s.id);
            await adminClient.from('settlements').delete().in('sale_id', saleIds);
            await adminClient.from('sales').delete().in('id', saleIds);
        }
    }

    const idsToDelete = unitsToDelete.map(u => u.id);
    const { error: deleteError } = await adminClient.from('product_units').delete().in('id', idsToDelete);
    if (deleteError) throw deleteError;

    await adminClient.from('products').update({ available_inventory: product.available_inventory + qty }).eq('id', product_id);

    await logAdminAction(adminId, 'PRODUCT_REMOVED', user_id, { product_id, quantity: qty, units_removed: unitsToRemove });
    return res.status(200).json({ success: true, message: `Removed ${qty} bulk package(s) (${unitsToRemove} units) of ${product.name}` });
}

async function handleAssignProduct(adminId, req, res) {
    const { user_id, product_id, quantity } = req.body;
    const qty = parseInt(quantity);
    if (!user_id || !product_id || !qty || qty < 1) {
        return res.status(400).json({ success: false, error: 'user_id, product_id and a positive quantity are required' });
    }

    const { data: product, error: productError } = await adminClient.from('products').select('*').eq('id', product_id).single();
    if (productError || !product) return res.status(404).json({ success: false, error: 'Product not found' });

    if (product.available_inventory < qty) {
        return res.status(400).json({ success: false, error: `Only ${product.available_inventory} bulk package(s) available for this product` });
    }

    const totalUnits = product.units_per_bulk * qty;
    const unitCost = product.bulk_price / product.units_per_bulk;

    const { data: purchase, error: purchaseError } = await adminClient
        .from('bulk_purchases')
        .insert({ user_id, product_id, quantity: qty, unit_count: totalUnits, total_amount: 0, status: 'COMPLETED' })
        .select()
        .single();
    if (purchaseError) throw purchaseError;

    const slugPrefix = (product.slug || product.name || 'PRD').replace(/[^a-zA-Z0-9]/g, '').substring(0, 4).toUpperCase();
    const purchaseFragment = purchase.id.replace(/-/g, '').substring(0, 6).toUpperCase();
    const unitsToInsert = Array.from({ length: totalUnits }, (_, i) => ({
        product_id,
        bulk_purchase_id: purchase.id,
        owner_id: user_id,
        unit_code: `${slugPrefix}-${purchaseFragment}-${String(i + 1).padStart(4, '0')}`,
        status: 'OWNED',
        acquisition_price: unitCost,
        selling_price: product.unit_selling_price
    }));

    const { error: unitsError } = await adminClient.from('product_units').insert(unitsToInsert);
    if (unitsError) throw unitsError;

    await adminClient.from('products').update({ available_inventory: product.available_inventory - qty }).eq('id', product_id);

    await logAdminAction(adminId, 'PRODUCT_ASSIGNED', user_id, { product_id, quantity: qty, total_units: totalUnits });
    return res.status(200).json({ success: true, message: `Assigned ${qty} bulk package(s) (${totalUnits} units) of ${product.name}` });
}

async function handleDeleteUnit(adminId, req, res) {
    const { unit_id } = req.body;
    if (!unit_id) return res.status(400).json({ success: false, error: 'unit_id required' });

    const { data: unit, error: unitError } = await adminClient.from('product_units').select('*').eq('id', unit_id).single();
    if (unitError || !unit) return res.status(404).json({ success: false, error: 'Unit not found' });

    let cascadedSale = false;
    if (unit.status === 'SOLD') {
        // Force-delete: this unit has a linked sales record (and possibly a
        // settlement). Removing it permanently erases that sale from
        // financial history/reports. Wallet balance is intentionally left
        // untouched — proceeds already paid out are not clawed back.
        const { data: relatedSales } = await adminClient.from('sales').select('id').eq('product_unit_id', unit_id);
        if (relatedSales?.length) {
            const saleIds = relatedSales.map(s => s.id);
            await adminClient.from('settlements').delete().in('sale_id', saleIds);
            await adminClient.from('sales').delete().in('id', saleIds);
            cascadedSale = true;
        }
    }

    const { error: deleteError } = await adminClient.from('product_units').delete().eq('id', unit_id);
    if (deleteError) throw deleteError;

    await logAdminAction(adminId, 'PRODUCT_UNIT_DELETED', unit_id, { product_id: unit.product_id, owner_id: unit.owner_id, unit_code: unit.unit_code, forced_sold_unit: cascadedSale });
    return res.status(200).json({ success: true, message: `Unit ${unit.unit_code} deleted successfully${cascadedSale ? ' (its linked sale/settlement records were also removed)' : ''}` });
}

async function handleAdjustWallet(adminId, req, res) {
    const { user_id, amount, reason } = req.body;
    const amt = parseFloat(amount);
    if (!user_id || !amt || amt === 0) {
        return res.status(400).json({ success: false, error: 'user_id and a non-zero amount are required' });
    }

    const { error } = await adminClient.rpc('adjust_wallet_balance', {
        p_user_id: user_id,
        p_amount: amt,
        p_type: 'ADMIN_ADJUSTMENT',
        p_reference: null,
        p_description: reason || (amt > 0 ? 'Admin fund addition' : 'Admin fund deduction')
    });
    if (error) return res.status(400).json({ success: false, error: error.message });

    await logAdminAction(adminId, 'WALLET_ADJUSTED', user_id, { amount: amt, reason: reason || null });
    return res.status(200).json({ success: true, message: `Wallet adjusted by ₦${amt.toLocaleString()}` });
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
