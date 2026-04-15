import { env } from '$env/dynamic/public';

// Supabase Configuration
export const SUPABASE_URL = env.PUBLIC_SUPABASE_URL || '';
export const SUPABASE_ANON_KEY = env.PUBLIC_SUPABASE_ANON_KEY || '';

// Solana RPC Endpoints
export const MAGICBLOCK_RPC = env.PUBLIC_MAGICBLOCK_RPC || 'https://rpc.magicblock.app/devnet/';
export const SOLANA_RPC = env.PUBLIC_SOLANA_RPC || env.PUBLIC_MAGICBLOCK_RPC || 'https://rpc.magicblock.app/devnet/';

// Pyth/Hermes Configuration
export const HERMES_URL = env.PUBLIC_HERMES_URL || 'https://hermes.pyth.network';
export const PYTH_API_KEY = env.PUBLIC_PYTH_API_KEY || '';

// Pyth Price Feed IDs
export const PYTH_FEEDS = {
	SOL: env.PUBLIC_PYTH_FEED_SOL || '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
	BTC: env.PUBLIC_PYTH_FEED_BTC || '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
	ETH: env.PUBLIC_PYTH_FEED_ETH || '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
	AVAX: env.PUBLIC_PYTH_FEED_AVAX || '0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7',
	LINK: env.PUBLIC_PYTH_FEED_LINK || '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
};

// Unified paper-trading Anchor program (only on-chain program used by the app)
export const PAPER_TRADING_PROGRAM_ID =
	env.PUBLIC_PAPER_TRADING_PROGRAM_ID || 'GTyA9zS7YrRJ7LQCqeKAYZa4yL2CSCaH6SmEALEWAXAk';

// External APIs
export const NEWS_API_URL = env.PUBLIC_NEWS_API_URL || 'https://min-api.cryptocompare.com/data/v2/news/';
export const RSS2JSON_API_URL = env.PUBLIC_RSS2JSON_API_URL || 'https://api.rss2json.com/v1/api.json';
