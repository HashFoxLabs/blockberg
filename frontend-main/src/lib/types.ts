// Database types matching the Supabase schema

export interface TradePostDB {
  id: string;
  owner_pubkey: string;
  pair_index: number;
  position_id: bigint;
  position_type: 'Long' | 'Short';
  amount_token_out: bigint;
  entry_price: bigint;
  exit_price: bigint;
  take_profit_price: bigint | null;
  stop_loss_price: bigint | null;
  opened_at: bigint;
  closed_at: bigint;
  position_pubkey: string | null;
  open_tx_signature: string | null;
  close_tx_signature: string | null;
  author_username: string | null;
  analysis: string | null;
  likes_count: number;
  comments_count: number;
  created_at: string;
}

// Frontend display type
export interface TradePost {
  id: string;
  author: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  exit: number;
  entryTimestamp: string;
  exitTimestamp: string;
  analysis: string;
  likes: number;
  comments: number;
}

// Comment types
export interface TradeCommentDB {
  id: string;
  trade_post_id: string;
  author_pubkey: string;
  author_username: string | null;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface TradeComment {
  id: string;
  author: string;
  content: string;
  createdAt: string;
}

// Map pair_index to trading pair symbols
export const PAIR_SYMBOLS: Record<number, string> = {
  0: 'SOL/USDT',
  1: 'BTC/USDT',
  2: 'ETH/USDT',
  3: 'AVAX/USDT',
  4: 'LINK/USDT'
};

// Helper function to convert database trade to frontend format
export function convertTradePostFromDB(dbTrade: TradePostDB): TradePost {
  // Convert prices from 6-decimal integers to floats
  const entryPrice = Number(dbTrade.entry_price) / 1_000_000;
  const exitPrice = Number(dbTrade.exit_price) / 1_000_000;
  
  // Convert Unix timestamps to readable format
  const entryDate = new Date(Number(dbTrade.opened_at) * 1000);
  const exitDate = new Date(Number(dbTrade.closed_at) * 1000);
  
  const formatDate = (date: Date): string => {
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const day = date.getDate();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day}, ${hours}:${minutes}`;
  };

  // Use author_username if set, otherwise format wallet address (owner_pubkey)
  const formatAddress = (addr: string): string => {
    if (!addr || addr.length < 12) return addr || 'Unknown';
    return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
  };
  const author = dbTrade.author_username?.trim() || formatAddress(dbTrade.owner_pubkey);
  
  return {
    id: dbTrade.id,
    author,
    symbol: PAIR_SYMBOLS[dbTrade.pair_index] || 'UNKNOWN',
    direction: dbTrade.position_type.toUpperCase() as 'LONG' | 'SHORT',
    entry: entryPrice,
    exit: exitPrice,
    entryTimestamp: formatDate(entryDate),
    exitTimestamp: formatDate(exitDate),
    analysis: dbTrade.analysis || 'No analysis provided.',
    likes: dbTrade.likes_count,
    comments: dbTrade.comments_count
  };
}

// Helper function to convert database comment to frontend format
export function convertCommentFromDB(dbComment: TradeCommentDB): TradeComment {
  const date = new Date(dbComment.created_at);
  const formatDate = (date: Date): string => {
    const month = date.toLocaleDateString('en-US', { month: 'short' });
    const day = date.getDate();
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    return `${month} ${day}, ${hours}:${minutes}`;
  };
  
  // Format wallet address if no username
  const formatWalletAddress = (address: string): string => {
    if (!address || address.length < 8) return 'Anonymous';
    return `${address.slice(0, 4)}...${address.slice(-4)}`;
  };
  
  // Use username if available, otherwise format the wallet address
  const authorName = dbComment.author_username || formatWalletAddress(dbComment.author_pubkey);
  
  return {
    id: dbComment.id,
    author: authorName,
    content: dbComment.content,
    createdAt: formatDate(date)
  };
}
