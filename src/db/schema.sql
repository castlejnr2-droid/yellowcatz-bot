-- YellowCatz Database Schema (PostgreSQL)

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id TEXT UNIQUE NOT NULL,
  username TEXT,
  first_name TEXT,
  gamble_balance DOUBLE PRECISION DEFAULT 0,
  spot_balance DOUBLE PRECISION DEFAULT 0,
  referral_code TEXT UNIQUE,
  referred_by TEXT,
  last_collect_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS collections (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  amount DOUBLE PRECISION NOT NULL,
  collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transfers (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  from_wallet TEXT NOT NULL CHECK(from_wallet IN ('gamble','spot')),
  to_wallet TEXT NOT NULL CHECK(to_wallet IN ('gamble','spot')),
  amount DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  amount DOUBLE PRECISION NOT NULL,
  solana_address TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  tx_hash TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS battles (
  id SERIAL PRIMARY KEY,
  challenger_id TEXT NOT NULL REFERENCES users(telegram_id),
  opponent_id TEXT,
  wager_amount DOUBLE PRECISION NOT NULL,
  status TEXT DEFAULT 'open' CHECK(status IN ('open','accepted','completed','cancelled','expired')),
  winner_id TEXT,
  challenger_roll INTEGER,
  opponent_roll INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referrals (
  id SERIAL PRIMARY KEY,
  referrer_id TEXT NOT NULL REFERENCES users(telegram_id),
  referred_id TEXT NOT NULL REFERENCES users(telegram_id),
  bonus_amount DOUBLE PRECISION DEFAULT 500,
  credited_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deposits (on-chain SPL token deposits)
CREATE TABLE IF NOT EXISTS deposits (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  amount DOUBLE PRECISION NOT NULL,
  tx_signature TEXT UNIQUE NOT NULL,
  from_address TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add deposit_ata column to users if not exists
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN deposit_ata TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Add fee column to withdrawals if not exists
DO $$ BEGIN
  ALTER TABLE withdrawals ADD COLUMN fee DOUBLE PRECISION DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- House fee balance
CREATE TABLE IF NOT EXISTS house_balance (
  id SERIAL PRIMARY KEY,
  balance DOUBLE PRECISION DEFAULT 0,
  total_fees_collected DOUBLE PRECISION DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO house_balance (balance, total_fees_collected)
SELECT 0, 0 WHERE NOT EXISTS (SELECT 1 FROM house_balance);

-- Fee amount per battle
DO $$ BEGIN
  ALTER TABLE battles ADD COLUMN fee_amount DOUBLE PRECISION DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_collections_user_id ON collections(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_battles_challenger ON battles(challenger_id);
CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status);
CREATE INDEX IF NOT EXISTS idx_deposits_user_id ON deposits(user_id);
CREATE INDEX IF NOT EXISTS idx_deposits_tx_signature ON deposits(tx_signature);

-- Add swept tracking columns to deposits
DO $$ BEGIN
  ALTER TABLE deposits ADD COLUMN swept BOOLEAN DEFAULT FALSE;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE deposits ADD COLUMN swept_at TIMESTAMPTZ;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Collector tier: lifetime total tokens ever collected (never decremented)
DO $$ BEGIN
  ALTER TABLE users ADD COLUMN total_collected DOUBLE PRECISION DEFAULT 0;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Backfill total_collected from existing collections for any user where it is still 0
UPDATE users u
SET total_collected = COALESCE((
  SELECT SUM(c.amount) FROM collections c WHERE c.user_id = u.telegram_id
), 0)
WHERE total_collected = 0
  AND EXISTS (SELECT 1 FROM collections c WHERE c.user_id = u.telegram_id);

-- Deposit wallets: tracks per-user deposit addresses and fee funding state
CREATE TABLE IF NOT EXISTS deposit_wallets (
  id SERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(telegram_id),
  deposit_address TEXT NOT NULL UNIQUE,
  derivation_index INTEGER DEFAULT 0,
  fee_funded BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_wallets_user_id ON deposit_wallets(user_id);
CREATE INDEX IF NOT EXISTS idx_deposit_wallets_address ON deposit_wallets(deposit_address);

-- Direct (locked) PvP duel challenges
CREATE TABLE IF NOT EXISTS duel_challenges (
  id SERIAL PRIMARY KEY,
  challenger_id TEXT NOT NULL REFERENCES users(telegram_id),
  target_id TEXT NOT NULL REFERENCES users(telegram_id),
  amount DOUBLE PRECISION NOT NULL,
  status TEXT DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled','declined','expired')),
  challenger_message_id BIGINT,
  target_message_id BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes'
);

CREATE INDEX IF NOT EXISTS idx_duel_challenger ON duel_challenges(challenger_id);
CREATE INDEX IF NOT EXISTS idx_duel_target ON duel_challenges(target_id);
CREATE INDEX IF NOT EXISTS idx_duel_status ON duel_challenges(status);

-- Chat where the main challenge (Accept/Decline) message lives
DO $$ BEGIN
  ALTER TABLE duel_challenges ADD COLUMN challenge_chat_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;

-- Chat where the Cancel button message lives (DM or same group)
DO $$ BEGIN
  ALTER TABLE duel_challenges ADD COLUMN cancel_chat_id TEXT;
EXCEPTION WHEN duplicate_column THEN NULL;
END $$;
