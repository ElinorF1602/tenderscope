# TenderScope Deployment Guide

## Quick Deploy (5 minutes)

### 1. Supabase Setup
1. Go to https://supabase.com and create a free account
2. Create a new project
3. Go to SQL Editor and run the contents of `supabase_setup.sql`
4. Go to Settings > API and copy:
   - Project URL
   - anon/public key

### 2. Vercel Deploy
1. Go to https://vercel.com and sign up with GitHub
2. Click "New Project" and import `ElinorF1602/tenderscope`
3. Add Environment Variables:
   - `ANTHROPIC_API_KEY` = your Anthropic API key
   - `NEXT_PUBLIC_SUPABASE_URL` = your Supabase project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = your Supabase anon key
4. Click Deploy!

### 3. Share with your team
Send the Vercel URL to your team — everyone shares the same database via Supabase.
