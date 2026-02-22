-- Trade Posts Table
-- Stores closed trading positions from on-chain data with social features

CREATE TABLE trade_posts (
  -- Identity
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- On-chain data (from PositionAccount)
  owner_pubkey TEXT NOT NULL,           -- owner (wallet address)
  pair_index SMALLINT NOT NULL,         -- 0=SOL/USDT, 1=BTC/USDT, etc.
  position_id BIGINT NOT NULL,          -- position_id from contract
  
  -- Trade details
  position_type TEXT NOT NULL           -- 'Long' or 'Short'
    CHECK (position_type IN ('Long', 'Short')),
  amount_token_out BIGINT NOT NULL,     -- position size
  
  -- Prices (stored as integers with 6 decimals, e.g., 145.32 = 145320000)
  entry_price BIGINT NOT NULL,          -- entry_price
  exit_price BIGINT NOT NULL,           -- close_price
  take_profit_price BIGINT,             -- take_profit_price (optional)
  stop_loss_price BIGINT,               -- stop_loss_price (optional)
  
  -- Timestamps (Unix timestamps from chain)
  opened_at BIGINT NOT NULL,            -- opened_at
  closed_at BIGINT NOT NULL,            -- closed_at
  
  -- Verification
  position_pubkey TEXT,                 -- PDA address for verification
  open_tx_signature TEXT,               -- Transaction hash
  close_tx_signature TEXT,
  
  -- Social features (off-chain only)
  author_username TEXT,                 -- Display name
  analysis TEXT,                        -- Trade commentary
  likes_count INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_trade_posts_owner ON trade_posts(owner_pubkey);
CREATE INDEX idx_trade_posts_pair ON trade_posts(pair_index);
CREATE INDEX idx_trade_posts_position_type ON trade_posts(position_type);
CREATE INDEX idx_trade_posts_created_at ON trade_posts(created_at DESC);
CREATE INDEX idx_trade_posts_closed_at ON trade_posts(closed_at DESC);

-- Unique constraint to prevent duplicate positions
CREATE UNIQUE INDEX idx_trade_posts_unique_position 
  ON trade_posts(owner_pubkey, pair_index, position_id);

-- Trade Comments Table
-- Stores individual comments on trade posts
CREATE TABLE trade_comments (
  -- Identity
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Relations
  trade_post_id UUID NOT NULL REFERENCES trade_posts(id) ON DELETE CASCADE,
  
  -- Author
  author_pubkey TEXT NOT NULL,          -- Wallet address of commenter
  author_username TEXT,                 -- Display name (optional)
  
  -- Content
  content TEXT NOT NULL,
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for comments
CREATE INDEX idx_trade_comments_trade_post ON trade_comments(trade_post_id);
CREATE INDEX idx_trade_comments_author ON trade_comments(author_pubkey);
CREATE INDEX idx_trade_comments_created_at ON trade_comments(created_at DESC);

-- Trade Likes Table
-- Stores individual likes on trade posts
CREATE TABLE trade_likes (
  -- Identity
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Relations
  trade_post_id UUID NOT NULL REFERENCES trade_posts(id) ON DELETE CASCADE,
  
  -- Author
  liker_pubkey TEXT NOT NULL,           -- Wallet address of person who liked
  liker_username TEXT,                  -- Display name (optional)
  
  -- Metadata
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  
  -- Prevent duplicate likes
  UNIQUE(trade_post_id, liker_pubkey)
);

-- Indexes for likes
CREATE INDEX idx_trade_likes_trade_post ON trade_likes(trade_post_id);
CREATE INDEX idx_trade_likes_liker ON trade_likes(liker_pubkey);

-- Function to update comments_count
CREATE OR REPLACE FUNCTION update_comments_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE trade_posts 
    SET comments_count = comments_count + 1 
    WHERE id = NEW.trade_post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE trade_posts 
    SET comments_count = GREATEST(0, comments_count - 1)
    WHERE id = OLD.trade_post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to update likes_count
CREATE OR REPLACE FUNCTION update_likes_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE trade_posts 
    SET likes_count = likes_count + 1 
    WHERE id = NEW.trade_post_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE trade_posts 
    SET likes_count = GREATEST(0, likes_count - 1)
    WHERE id = OLD.trade_post_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Triggers to automatically update counts
CREATE TRIGGER trigger_update_comments_count
  AFTER INSERT OR DELETE ON trade_comments
  FOR EACH ROW
  EXECUTE FUNCTION update_comments_count();

CREATE TRIGGER trigger_update_likes_count
  AFTER INSERT OR DELETE ON trade_likes
  FOR EACH ROW
  EXECUTE FUNCTION update_likes_count();

-- Comments
COMMENT ON TABLE trade_posts IS 'Stores closed trading positions with social features';
COMMENT ON TABLE trade_comments IS 'Stores comments on trade posts';
COMMENT ON TABLE trade_likes IS 'Stores likes on trade posts';
COMMENT ON COLUMN trade_posts.pair_index IS '0=SOL/USDT, 1=BTC/USDT, 2=ETH/USDT, 3=AVAX/USDT';
COMMENT ON COLUMN trade_posts.entry_price IS 'Price with 6 decimals (e.g., 145.32 = 145320000)';
COMMENT ON COLUMN trade_posts.exit_price IS 'Price with 6 decimals (e.g., 160.00 = 160000000)';

-- ============================================
-- SAMPLE DATA - Example Trade Posts
-- ============================================

-- Sample Trade 1: SOL/USDT Long (Profitable)
INSERT INTO trade_posts (
  owner_pubkey,
  pair_index,
  position_id,
  position_type,
  amount_token_out,
  entry_price,
  exit_price,
  take_profit_price,
  stop_loss_price,
  opened_at,
  closed_at,
  position_pubkey,
  author_username,
  analysis,
  likes_count,
  comments_count
) VALUES (
  'CryptoTrader42WalletAddress1234567890ABCDEF',
  0, -- SOL/USDT
  1,
  'Long',
  1000000000, -- 1 SOL (9 decimals)
  145320000, -- $145.32 (6 decimals)
  160000000, -- $160.00 (6 decimals)
  165000000, -- TP: $165.00
  140000000, -- SL: $140.00
  1708416000, -- Feb 20, 2024 10:00:00 UTC
  1708502400, -- Feb 21, 2024 08:00:00 UTC
  'PositionPDA1234567890ABCDEF',
  'CryptoTrader42',
  'Strong support at $140, expecting breakout above $150 resistance. RSI shows bullish divergence.',
  24,
  8
);

-- Sample Trade 2: BTC/USDT Long (Loss)
INSERT INTO trade_posts (
  owner_pubkey,
  pair_index,
  position_id,
  position_type,
  amount_token_out,
  entry_price,
  exit_price,
  take_profit_price,
  stop_loss_price,
  opened_at,
  closed_at,
  position_pubkey,
  author_username,
  analysis,
  likes_count,
  comments_count
) VALUES (
  'BTCMaximalistWalletAddress1234567890ABCDEF',
  1, -- BTC/USDT
  1,
  'Long',
  100000000, -- 1 BTC (8 decimals)
  68500000000, -- $68,500 (6 decimals)
  66000000000, -- $66,000 (6 decimals)
  72000000000, -- TP: $72,000
  65000000000, -- SL: $65,000
  1708430400, -- Feb 20, 2024 14:00:00 UTC
  1708495200, -- Feb 21, 2024 06:00:00 UTC
  'PositionPDA2345678901BCDEFG',
  'BTCMaximalist',
  'Bitcoin forming ascending triangle pattern. Volume increasing on green candles. 200 MA acting as support.',
  42,
  15
);

-- Sample Trade 3: ETH/USDT Short (Profitable)
INSERT INTO trade_posts (
  owner_pubkey,
  pair_index,
  position_id,
  position_type,
  amount_token_out,
  entry_price,
  exit_price,
  take_profit_price,
  stop_loss_price,
  opened_at,
  closed_at,
  position_pubkey,
  author_username,
  analysis,
  likes_count,
  comments_count
) VALUES (
  'ETHwhaleWalletAddress1234567890ABCDEF',
  2, -- ETH/USDT
  1,
  'Short',
  1000000000, -- 10 ETH (8 decimals = 1 ETH is 100000000, so 10 ETH)
  3520000000, -- $3,520 (6 decimals)
  3200000000, -- $3,200 (6 decimals)
  3100000000, -- TP: $3,100
  3700000000, -- SL: $3,700
  1708401600, -- Feb 20, 2024 08:00:00 UTC
  1708488000, -- Feb 21, 2024 04:00:00 UTC
  'PositionPDA3456789012CDEFGH',
  'ETHwhale',
  'Overbought on the 4H chart. Expecting pullback to test major support. Risk/reward favorable.',
  18,
  6
);

-- Sample Trade 4: AVAX/USDT Long (Profitable)
INSERT INTO trade_posts (
  owner_pubkey,
  pair_index,
  position_id,
  position_type,
  amount_token_out,
  entry_price,
  exit_price,
  take_profit_price,
  stop_loss_price,
  opened_at,
  closed_at,
  position_pubkey,
  author_username,
  analysis,
  likes_count,
  comments_count
) VALUES (
  'AltcoinWizardWalletAddress1234567890ABCDEF',
  3, -- AVAX/USDT
  1,
  'Long',
  100000000000, -- 100 AVAX (9 decimals)
  42150000, -- $42.15 (6 decimals)
  48500000, -- $48.50 (6 decimals)
  52000000, -- TP: $52.00
  38000000, -- SL: $38.00
  1708387200, -- Feb 20, 2024 04:00:00 UTC
  1708481280, -- Feb 21, 2024 02:00:00 UTC (approximately)
  'PositionPDA4567890123DEFGHI',
  'AltcoinWizard',
  'Breaking out of consolidation range. Strong fundamentals with upcoming ecosystem updates.',
  31,
  11
);

-- Sample Trade 5: SOL/USDT Short (Loss)
INSERT INTO trade_posts (
  owner_pubkey,
  pair_index,
  position_id,
  position_type,
  amount_token_out,
  entry_price,
  exit_price,
  opened_at,
  closed_at,
  position_pubkey,
  author_username,
  analysis,
  likes_count,
  comments_count
) VALUES (
  'SolarTraderWalletAddress1234567890ABCDEF',
  0, -- SOL/USDT
  2,
  'Short',
  5000000000, -- 5 SOL (9 decimals)
  142000000, -- $142.00 (6 decimals)
  150000000, -- $150.00 (6 decimals)
  1708373600, -- Feb 19, 2024 23:00:00 UTC
  1708459200, -- Feb 20, 2024 18:00:00 UTC
  'PositionPDA5678901234EFGHIJ',
  'SolarTrader',
  'Expected rejection at resistance but got faked out. Cut losses quickly.',
  5,
  3
);

-- Sample Trade 6: BTC/USDT Short (Profitable)
INSERT INTO trade_posts (
  owner_pubkey,
  pair_index,
  position_id,
  position_type,
  amount_token_out,
  entry_price,
  exit_price,
  opened_at,
  closed_at,
  position_pubkey,
  author_username,
  analysis,
  likes_count,
  comments_count
) VALUES (
  'BTCBearWalletAddress1234567890ABCDEF',
  1, -- BTC/USDT
  2,
  'Short',
  50000000, -- 0.5 BTC (8 decimals)
  69800000000, -- $69,800 (6 decimals)
  67200000000, -- $67,200 (6 decimals)
  1708344000, -- Feb 19, 2024 14:00:00 UTC
  1708423200, -- Feb 20, 2024 12:00:00 UTC
  'PositionPDA6789012345FGHIJK',
  'BTCBear',
  'BTC showing weakness at resistance. Multiple rejections at $70k. Time to short.',
  28,
  9
);

-- ============================================
-- Sample Comments
-- ============================================

-- Comments on Trade 1 (SOL Long)
INSERT INTO trade_comments (trade_post_id, author_pubkey, author_username, content)
SELECT id, 'CommenterWallet1', 'TraderJoe', 'Great call! I followed this trade and made 10% profit!'
FROM trade_posts WHERE author_username = 'CryptoTrader42' AND pair_index = 0 AND position_id = 1;

INSERT INTO trade_comments (trade_post_id, author_pubkey, author_username, content)
SELECT id, 'CommenterWallet2', 'SolanaBull', 'The RSI divergence was spot on. Well analyzed!'
FROM trade_posts WHERE author_username = 'CryptoTrader42' AND pair_index = 0 AND position_id = 1;

-- Comments on Trade 2 (BTC Long Loss)
INSERT INTO trade_comments (trade_post_id, author_pubkey, author_username, content)
SELECT id, 'CommenterWallet3', 'Analyst99', 'Tough break. The setup looked good though.'
FROM trade_posts WHERE author_username = 'BTCMaximalist' AND pair_index = 1 AND position_id = 1;

-- Comments on Trade 3 (ETH Short)
INSERT INTO trade_comments (trade_post_id, author_pubkey, author_username, content)
SELECT id, 'CommenterWallet4', 'ChartMaster', 'Nice short! The 4H timeframe was clearly overbought.'
FROM trade_posts WHERE author_username = 'ETHwhale' AND pair_index = 2 AND position_id = 1;

-- ============================================
-- Sample Likes
-- ============================================

-- Likes on Trade 1
INSERT INTO trade_likes (trade_post_id, liker_pubkey, liker_username)
SELECT id, 'LikerWallet1', 'UserA'
FROM trade_posts WHERE author_username = 'CryptoTrader42' AND pair_index = 0 AND position_id = 1;

INSERT INTO trade_likes (trade_post_id, liker_pubkey, liker_username)
SELECT id, 'LikerWallet2', 'UserB'
FROM trade_posts WHERE author_username = 'CryptoTrader42' AND pair_index = 0 AND position_id = 1;

-- Likes on Trade 4
INSERT INTO trade_likes (trade_post_id, liker_pubkey, liker_username)
SELECT id, 'LikerWallet3', 'UserC'
FROM trade_posts WHERE author_username = 'AltcoinWizard' AND pair_index = 3 AND position_id = 1;
