# CAPITAL COVE - Bulk Purchase & Resale Platform

## Tech Stack
- Frontend: Vanilla HTML/CSS/JS (Vite)
- Backend: Supabase (Auth, PostgreSQL, RLS)
- Hosting: Vercel

## Setup
1. Clone the repository.
2. Run `npm install`.
3. Create a `.env` file with your `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
4. Run the SQL scripts in `supabase/` folder in your Supabase SQL Editor in this order:
   - schema.sql
   - functions.sql
   - triggers.sql
   - seed.sql
   - rls.sql
5. Run `npm run dev` to start locally.

## Deployment
Push to GitHub and connect to Vercel. Ensure environment variables are set in Vercel Dashboard.
