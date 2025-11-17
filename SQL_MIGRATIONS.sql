-- SQL Migrations for Complete Subscription System
-- Run these migrations to ensure all required fields exist

-- ============================================
-- USERS TABLE: Subscription Fields
-- ============================================

-- Subscription status (trial, active, expired, pending_activation)
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'trial';

-- Trial expiry date (set on user creation)
ALTER TABLE users ADD COLUMN IF NOT EXISTS trial_expires_at TIMESTAMP WITH TIME ZONE;

-- Subscription start date (set when subscription is activated)
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_started_at TIMESTAMP WITH TIME ZONE;

-- Subscription expiry date (set when subscription is activated: now + 28 days)
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP WITH TIME ZONE;

-- Notification flags
ALTER TABLE users ADD COLUMN IF NOT EXISTS notified_trial_expired BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notified_subscription_expired BOOLEAN DEFAULT FALSE;

-- Razorpay integration fields
ALTER TABLE users ADD COLUMN IF NOT EXISTS razorpay_customer_id VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_id VARCHAR(255);

-- ============================================
-- PAYMENTS TABLE: Payment Records
-- ============================================

-- Create payments table if it doesn't exist
CREATE TABLE IF NOT EXISTS payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  razorpay_payment_id VARCHAR(255),
  amount BIGINT, -- Amount in paise
  currency VARCHAR(10) DEFAULT 'INR',
  status VARCHAR(50),
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Unique index on razorpay_payment_id for idempotency (prevents duplicate payments)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_razorpay_payment_id 
  ON payments(razorpay_payment_id) 
  WHERE razorpay_payment_id IS NOT NULL;

-- Index on user_id for faster lookups
CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments(user_id);

-- Index on created_at for reporting
CREATE INDEX IF NOT EXISTS idx_payments_created_at ON payments(created_at);

-- ============================================
-- SCRAPER FAILURES TABLE (if needed)
-- ============================================

CREATE TABLE IF NOT EXISTS scraper_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_id VARCHAR(50) NOT NULL,
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scraper_failures_user_id ON scraper_failures(user_id);
CREATE INDEX IF NOT EXISTS idx_scraper_failures_created_at ON scraper_failures(created_at);

-- ============================================
-- VERIFICATION
-- ============================================

-- Verify all columns exist
SELECT 
  column_name, 
  data_type, 
  is_nullable, 
  column_default
FROM information_schema.columns 
WHERE table_name = 'users' 
  AND column_name IN (
    'subscription_status',
    'trial_expires_at',
    'subscription_started_at',
    'subscription_expires_at',
    'notified_trial_expired',
    'notified_subscription_expired',
    'razorpay_customer_id',
    'subscription_id'
  )
ORDER BY column_name;

-- Verify payments table exists
SELECT 
  table_name,
  column_name,
  data_type
FROM information_schema.columns
WHERE table_name = 'payments'
ORDER BY ordinal_position;

-- Verify unique index exists
SELECT 
  indexname,
  indexdef
FROM pg_indexes
WHERE tablename = 'payments'
  AND indexname = 'idx_payments_razorpay_payment_id';
