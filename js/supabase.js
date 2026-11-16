import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_CONFIG } from './config.js';

export function isSupabaseConfigured() {
  return SUPABASE_CONFIG.url.startsWith('https://')
    && !SUPABASE_CONFIG.url.includes('YOUR_PROJECT_ID')
    && SUPABASE_CONFIG.anonKey.length > 30
    && !SUPABASE_CONFIG.anonKey.includes('YOUR_SUPABASE');
}

export function createSupabaseClient() {
  if (!isSupabaseConfigured()) {
    throw new Error('Configura la URL y la clave pública anon de Supabase en js/config.js.');
  }

  return createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
    auth: {
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: true
    },
    realtime: {
      params: { eventsPerSecond: 5 }
    }
  });
}

export function getDeviceName() {
  const agent = navigator.userAgent;
  if (/iPad|Tablet/i.test(agent)) return 'Tableta';
  if (/iPhone|Android.*Mobile/i.test(agent)) return 'Teléfono';
  return 'Este dispositivo';
}
