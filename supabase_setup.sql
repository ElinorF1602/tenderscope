-- Run this in Supabase → SQL Editor → New Query

-- Create the shared key-value store table
CREATE TABLE IF NOT EXISTS kv_store (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable Row Level Security
ALTER TABLE kv_store ENABLE ROW LEVEL SECURITY;

-- Allow anyone with the anon key to read and write
-- (suitable for internal team tools without user auth)
CREATE POLICY "Allow all for anon" ON kv_store
  FOR ALL
  USING (true)
  WITH CHECK (true);
