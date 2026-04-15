import { supabase, isSupabaseConfigured } from '$lib/supabase';
import { convertTradePostFromDB, type TradePost, type TradePostDB } from '$lib/types';
import type { PageLoad } from './$types';

// Sample fallback data when Supabase is not configured
const sampleTradePosts: TradePost[] = [
  {
    id: '1',
    author: 'CryptoTrader42',
    symbol: 'SOL/USDT',
    direction: 'LONG',
    entry: 145.32,
    exit: 160.00,
    entryTimestamp: 'Feb 20, 10:00',
    exitTimestamp: 'Feb 21, 08:00',
    analysis: 'Strong support at $140, expecting breakout above $150 resistance. RSI shows bullish divergence.',
    likes: 24,
    comments: 8
  },
  {
    id: '2',
    author: 'BTCMaximalist',
    symbol: 'BTC/USDT',
    direction: 'LONG',
    entry: 68500,
    exit: 66000,
    entryTimestamp: 'Feb 20, 14:00',
    exitTimestamp: 'Feb 21, 06:00',
    analysis: 'Bitcoin forming ascending triangle pattern. Volume increasing on green candles. 200 MA acting as support.',
    likes: 42,
    comments: 15
  },
  {
    id: '3',
    author: 'ETHwhale',
    symbol: 'ETH/USDT',
    direction: 'SHORT',
    entry: 3520,
    exit: 3200,
    entryTimestamp: 'Feb 20, 08:00',
    exitTimestamp: 'Feb 21, 04:00',
    analysis: 'Overbought on the 4H chart. Expecting pullback to test major support. Risk/reward favorable.',
    likes: 18,
    comments: 6
  },
  {
    id: '4',
    author: 'AltcoinWizard',
    symbol: 'AVAX/USDT',
    direction: 'LONG',
    entry: 42.15,
    exit: 48.50,
    entryTimestamp: 'Feb 20, 04:00',
    exitTimestamp: 'Feb 21, 02:00',
    analysis: 'Breaking out of consolidation range. Strong fundamentals with upcoming ecosystem updates.',
    likes: 31,
    comments: 11
  }
];

export const ssr = false;

export const load: PageLoad = async () => {
  // If Supabase is not configured, return sample data
  if (!isSupabaseConfigured || !supabase) {
    console.warn('Supabase not configured. Using sample data. Please set up your .env file with Supabase credentials.');
    return {
      tradePosts: sampleTradePosts
    };
  }

  try {
    // Fetch trade posts from Supabase (newest posts first)
    const { data, error } = await supabase
      .from('trade_posts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20); // Get the 20 most recent trades

    if (error) {
      console.error('Error fetching trade posts:', error);
      return {
        tradePosts: sampleTradePosts
      };
    }

    // Convert database format to frontend format
    const tradePosts: TradePost[] = (data as TradePostDB[]).map(convertTradePostFromDB);

    return {
      tradePosts
    };
  } catch (error) {
    console.error('Error loading trade posts:', error);
    return {
      tradePosts: sampleTradePosts
    };
  }
};

