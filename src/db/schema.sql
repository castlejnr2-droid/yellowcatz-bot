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

-- Indexes
CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code);
CREATE INDEX IF NOT EXISTS idx_collections_user_id ON collections(user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_user_id ON withdrawals(user_id);
CREATE INDEX IF NOT EXISTS idx_battles_challenger ON battles(challenger_id);
CREATE INDEX IF NOT EXISTS idx_battles_status ON battles(status);
