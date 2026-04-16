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

// Pyth Price Feed IDs — top 20 coins by market cap (excl. stablecoins)
export const PYTH_FEEDS = {
	BTC:  env.PUBLIC_PYTH_FEED_BTC  || '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
	ETH:  env.PUBLIC_PYTH_FEED_ETH  || '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
	BNB:  env.PUBLIC_PYTH_FEED_BNB  || '0x2f95862b045670cd22bee3114c39763a4a08beeb663b145d283c31d7d1101c4f',
	SOL:  env.PUBLIC_PYTH_FEED_SOL  || '0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
	XRP:  env.PUBLIC_PYTH_FEED_XRP  || '0xec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
	DOGE: env.PUBLIC_PYTH_FEED_DOGE || '0xdcef50dd0a4cd2dcc17e45df1676dcb336a11a61c69df7a0299b0150c672d25c',
	ADA:  env.PUBLIC_PYTH_FEED_ADA  || '0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d',
	TRX:  env.PUBLIC_PYTH_FEED_TRX  || '0x67aed5a24fdad045475e7195c98a98aea119c763f272d4523f5bac93a4f33c2b',
	AVAX: env.PUBLIC_PYTH_FEED_AVAX || '0x93da3352f9f1d105fdfe4971cfa80e9dd777bfc5d0f683ebb6e1294b92137bb7',
	LINK: env.PUBLIC_PYTH_FEED_LINK || '0x8ac0c70fff57e9aefdf5edf44b51d62c2d433653cbb2cf5cc06bb115af04d221',
	DOT:  env.PUBLIC_PYTH_FEED_DOT  || '0xca3eed9b267293f6595901c734c7525ce8ef49adafe8284606ceb307afa2ca5b',
	MATIC:env.PUBLIC_PYTH_FEED_MATIC|| '0xffd11c5a1cfd42f80afb2df4d9f264c15f956d68153335374ec10722edd70472',
	LTC:  env.PUBLIC_PYTH_FEED_LTC  || '0x6e3f3fa8253588df9326580180233eb791e03b443a3ba7a1d892e73874e19a54',
	UNI:  env.PUBLIC_PYTH_FEED_UNI  || '0x78d185a741d07edb3412b09008b7c5cfb9bbbd7d568bf00ba737b456ba171501',
	ATOM: env.PUBLIC_PYTH_FEED_ATOM || '0xb00b60f88b03a6a625a8d1c048c3f66653edf217439983d037e7222c4e612819',
	NEAR: env.PUBLIC_PYTH_FEED_NEAR || '0xc415de8d2eba7db216527dff4b60e8f3a5311c740dadb233e13e12547e226750',
	APT:  env.PUBLIC_PYTH_FEED_APT  || '0x03ae4db29ed4ae33d323568895aa00337e658e348b37509f5372ae51f0af00d5',
	SUI:  env.PUBLIC_PYTH_FEED_SUI  || '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744',
	INJ:  env.PUBLIC_PYTH_FEED_INJ  || '0x7a5bc1d2b56ad029048cd63964b3ad2776eadf812edc1a43a31406cb54bff592',
	TAO:  env.PUBLIC_PYTH_FEED_TAO  || '0x410f41de235f2db824e562ea7ab2d3d3d4ff048316c61d629c0b93f58584e1af',
};

// Unified paper-trading Anchor program (only on-chain program used by the app)
export const PAPER_TRADING_PROGRAM_ID =
	env.PUBLIC_PAPER_TRADING_PROGRAM_ID || 'GTyA9zS7YrRJ7LQCqeKAYZa4yL2CSCaH6SmEALEWAXAk';

// External APIs
export const NEWS_API_URL = env.PUBLIC_NEWS_API_URL || 'https://min-api.cryptocompare.com/data/v2/news/';
export const RSS2JSON_API_URL = env.PUBLIC_RSS2JSON_API_URL || 'https://api.rss2json.com/v1/api.json';
