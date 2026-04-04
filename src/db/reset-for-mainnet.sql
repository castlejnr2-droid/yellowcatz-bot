-- ONE-TIME RESET: Beta → Mainnet transition
-- Run once before token launch. Never again.

-- Clear all activity tables
TRUNCATE TABLE referrals CASCADE;
TRUNCATE TABLE battles CASCADE;
TRUNCATE TABLE withdrawals CASCADE;
TRUNCATE TABLE transfers CASCADE;
TRUNCATE TABLE collections CASCADE;

-- Clear deposits if table exists
DO $$ BEGIN
  EXECUTE 'TRUNCATE TABLE deposits CASCADE';
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- Reset all user balances to zero, clear deposit ATAs
UPDATE users SET 
  gamble_balance = 0,
  spot_balance = 0,
  last_collect_at = NULL,
  deposit_ata = NULL,
  updated_at = NOW();

-- Done. All balances zero, all history cleared, deposit ATAs will be regenerated.
