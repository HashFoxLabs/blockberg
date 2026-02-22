import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '$env/static/public';

// Check if Supabase is configured
const isSupabaseConfigured = 
  PUBLIC_SUPABASE_URL && 
  PUBLIC_SUPABASE_ANON_KEY && 
  PUBLIC_SUPABASE_URL !== 'your-project-url' &&
  PUBLIC_SUPABASE_ANON_KEY !== 'your-anon-key' &&
  !PUBLIC_SUPABASE_URL.includes('your-project');

// Create a single supabase client for interacting with your database
// Only create the client if properly configured
export const supabase = isSupabaseConfigured 
  ? createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY)
  : null;

export { isSupabaseConfigured };
