import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export default async function handler(req, res) {
    // 1. HTTP Method Enforcement
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed. Use GET.' });
    }

    const { action, id, slug, category, search, sort, order, page = 1, limit = 10 } = req.query;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    try {
        switch (action) {
            case 'list':
                return await handleListProducts(res, { category, search, sort, order, page, limit });
            
            case 'details':
                return await handleProductDetails(res, { id, slug });

            default:
                return res.status(400).json({ success: false, error: 'Invalid action parameter.' });
        }
    } catch (error) {
        console.error('[API/PRODUCTS] Server Error:', error.message);
        return res.status(500).json({ success: false, error: 'An unexpected error occurred.' });
    }
}

/**
 * Handle listing active products with filtering, search, and pagination
 */
async function handleListProducts(res, params) {
    const { category, search, sort, order, page, limit } = params;

    // 1. Sanitize Pagination
    const p = Math.max(1, parseInt(page));
    const l = Math.min(50, Math.max(1, parseInt(limit))); // Cap at 50 for performance
    const from = (p - 1) * l;
    const to = from + l - 1;

    // 2. Build Base Query (Only Active Products)
    let query = supabase
        .from('products')
        .select(`
            id, name, slug, category, description, image_url, 
            bulk_price, units_per_bulk, unit_selling_price, 
            purchase_limit, available_inventory, status, created_at
        `, { count: 'exact' })
        .eq('status', 'ACTIVE');

    // 3. Category Filter
    if (category && category.trim() !== '') {
        query = query.eq('category', category.trim());
    }

    // 4. Search Filter (Safe ILIKE)
    if (search && search.trim() !== '') {
        const searchTerm = `%${search.trim()}%`;
        query = query.or(`name.ilike.${searchTerm},description.ilike.${searchTerm},category.ilike.${searchTerm}`);
    }

    // 5. Safe Sorting (Allowlist)
    const allowedSortFields = ['created_at', 'name', 'bulk_price', 'unit_selling_price'];
    const sortField = allowedSortFields.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? true : false;
    query = query.order(sortField, { ascending: sortOrder });

    // 6. Pagination Execution
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
            has_next: to < count - 1,
            has_previous: p > 1
        }
    });
}

/**
 * Handle retrieving details for a single product via ID or Slug
 */
async function handleProductDetails(res, params) {
    const { id, slug } = params;

    if (!id && !slug) {
        return res.status(400).json({ success: false, error: 'Product ID or Slug is required.' });
    }

    let query = supabase
        .from('products')
        .select(`
            id, name, slug, category, description, image_url, 
            bulk_price, units_per_bulk, unit_selling_price, 
            purchase_limit, available_inventory, status, created_at, updated_at
        `)
        .eq('status', 'ACTIVE');

    if (id) {
        query = query.eq('id', id);
    } else {
        query = query.eq('slug', slug);
    }

    const { data, error } = await query.single();

    if (error || !data) {
        return res.status(404).json({ success: false, error: 'Product not found or unavailable.' });
    }

    // Response explicitly uses "suggested_unit_selling_price" mapping 
    // to reinforce the marketplace model to the frontend
    const productResponse = {
        ...data,
        suggested_unit_selling_price: data.unit_selling_price
    };

    return res.status(200).json({
        success: true,
        data: productResponse
    });
}
