import { createClient } from '@supabase/supabase-js';

// --- CONFIGURATION ---
// Use Service Role Key for administrative tasks (like validating referral codes before user exists)
// and Anon Key for user-scoped actions.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Administrative client
const adminClient = createClient(supabaseUrl, supabaseServiceKey);

export default async function handler(req, res) {
    const { method, query } = req;
    const action = query.action;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,POST,PUT');
    res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization');

    if (method === 'OPTIONS') return res.status(200).end();

    try {
        switch (action) {
            case 'register':
                if (method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleRegister(req, res);

            case 'login':
                if (method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleLogin(req, res);

            case 'me':
                if (method !== 'GET') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleMe(req, res);

            case 'update-profile':
                if (method !== 'PATCH') return res.status(405).json({ success: false, error: 'Method not allowed' });
                return await handleUpdateProfile(req, res);

            default:
                return res.status(400).json({ success: false, error: 'Invalid action' });
        }
    } catch (error) {
        console.error(`[API/AUTH] Error in ${action}:`, error);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
}

/**
 * Handle User Registration
 * Uses Supabase Auth and links referral data in user metadata for the DB trigger.
 */
async function handleRegister(req, res) {
    const { email, password, full_name, phone, referral_code } = req.body;

    // 1. Validation
    if (!email || !password || !full_name || !phone) {
        return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    if (password.length < 6) {
        return res.status(400).json({ success: false, error: 'Password must be at least 6 characters' });
    }

    // 2. Validate Referral Code if provided
    let referredBy = null;
    if (referral_code) {
        const { data: referrer, error: refError } = await adminClient
            .from('profiles')
            .select('id')
            .eq('referral_code', referral_code.trim().toUpperCase())
            .single();

        if (refError || !referrer) {
            return res.status(400).json({ success: false, error: 'Invalid referral code' });
        }
        referredBy = referrer.id;
    }

    // 3. Supabase Auth SignUp
    // We pass extra data in options.data. The database trigger 'handle_new_user' 
    // defined in Step 1 will extract these to create the profile and referral record.
    const { data, error } = await adminClient.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // Manual override if Vercel Hobby setup lacks SMTP
        user_metadata: {
            full_name: full_name.trim(),
            phone: phone.trim(),
            referred_by: referredBy
        }
    });

    if (error) {
        return res.status(error.status || 400).json({ success: false, error: error.message });
    }

    return res.status(201).json({ 
        success: true, 
        data: { user_id: data.user.id, email: data.user.email } 
    });
}

/**
 * Handle User Login
 */
async function handleLogin(req, res) {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, error: 'Email and password required' });
    }

    // Create a temporary client with the provided credentials to verify
    const userClient = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY);
    const { data, error } = await userClient.auth.signInWithPassword({ email, password });

    if (error) {
        return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    return res.status(200).json({ 
        success: true, 
        data: { session: data.session } 
    });
}

/**
 * Get Current User Profile
 */
async function handleMe(req, res) {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const userClient = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return res.status(401).json({ success: false, error: 'Invalid session' });

    // Fetch profile data
    const { data: profile, error: profError } = await userClient
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .single();

    if (profError) return res.status(404).json({ success: false, error: 'Profile not found' });

    return res.status(200).json({
        success: true,
        data: {
            id: user.id,
            email: user.email,
            profile: profile
        }
    });
}

/**
 * Update Profile Information (Allowlist only)
 */
async function handleUpdateProfile(req, res) {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const { full_name, phone, avatar_url } = req.body;

    const userClient = createClient(supabaseUrl, process.env.VITE_SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } }
    });

    const { data: { user }, error: authError } = await userClient.auth.getUser();
    if (authError || !user) return res.status(401).json({ success: false, error: 'Invalid session' });

    // Build update object based on allowlist
    const updates = {};
    if (full_name) updates.full_name = full_name.trim();
    if (phone) updates.phone = phone.trim();
    if (avatar_url) updates.avatar_url = avatar_url;
    updates.updated_at = new Date().toISOString();

    const { data: updatedProfile, error: updateError } = await userClient
        .from('profiles')
        .update(updates)
        .eq('id', user.id)
        .select()
        .single();

    if (updateError) {
        return res.status(400).json({ success: false, error: updateError.message });
    }

    return res.status(200).json({
        success: true,
        data: updatedProfile
    });
}
