import { createClient } from '@supabase/supabase-js';
import { env } from '$env/dynamic/public';

// Get environment variables with fallback to empty strings
const PUBLIC_SUPABASE_URL = env.PUBLIC_SUPABASE_URL || '';
const PUBLIC_SUPABASE_ANON_KEY = env.PUBLIC_SUPABASE_ANON_KEY || '';

// Check if Supabase is configured
const isSupabaseConfigured =
  PUBLIC_SUPABASE_URL &&
  PUBLIC_SUPABASE_ANON_KEY &&
  PUBLIC_SUPABASE_URL !== 'your-project-url' &&
  PUBLIC_SUPABASE_ANON_KEY !== 'your-anon-key' &&
  PUBLIC_SUPABASE_URL !== 'here' &&
  PUBLIC_SUPABASE_ANON_KEY !== 'here' &&
  !PUBLIC_SUPABASE_URL.includes('your-project');

// Create a single supabase client for interacting with your database
// Only create the client if properly configured
export const supabase = isSupabaseConfigured
  ? createClient(PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY)
  : null;

export { isSupabaseConfigured };
