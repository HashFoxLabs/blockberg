import { supabase, isSupabaseConfigured } from '$lib/supabase';
import { convertTradePostFromDB, type TradePost, type TradePostDB } from '$lib/types';
import type { PageLoad } from './$types';

export const ssr = false;

export const load: PageLoad = async () => {
  // Check if Supabase is configured
  if (!isSupabaseConfigured || !supabase) {
    console.error('Supabase not configured. Please set up your .env file with Supabase credentials.');
    return {
      tradePosts: []
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
        tradePosts: []
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
      tradePosts: []
    };
  }
};

