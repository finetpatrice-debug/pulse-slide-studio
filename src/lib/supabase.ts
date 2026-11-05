import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL?.trim() || 'https://ztjppnonfccdytvgpqrl.supabase.co';
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim() ||
  'sb_publishable_kaNBOm-Q29rHSWImjMnWAg_E0QB16Eu';

export const isSupabaseConfigured = Boolean(
  supabaseUrl &&
    supabaseAnonKey &&
    !supabaseUrl.includes('votre-projet') &&
    !supabaseAnonKey.includes('votre-cle')
);

if (!isSupabaseConfigured) {
  console.warn(
    '[Supabase] VITE_SUPABASE_URL ou VITE_SUPABASE_ANON_KEY manquant dans .env.local. ' +
      'Le mode démo local (localStorage + BroadcastChannel) prendra automatiquement le relais.'
  );
}

export const supabase = createClient(
  isSupabaseConfigured ? supabaseUrl : 'https://placeholder.supabase.co',
  isSupabaseConfigured ? supabaseAnonKey : 'placeholder-anon-key',
  {
    realtime: {
      params: {
        eventsPerSecond: 20,
      },
    },
  }
);

/**
 * Retourne l'URL de base accessible sur le réseau local (Wi-Fi) pour le QR Code.
 * Si l'application est ouverte via localhost sur le PC du formateur, remplace automatiquement
 * localhost par l'adresse IPv4 locale détectée par Vite (ex: http://192.168.1.x:5173).
 */
export function getNetworkBaseUrl(): string {
  const { protocol, hostname, port } = window.location;
  const localLanIp = typeof __LOCAL_LAN_IP__ !== 'undefined' ? __LOCAL_LAN_IP__ : null;

  if ((hostname === 'localhost' || hostname === '127.0.0.1') && localLanIp) {
    return `${protocol}//${localLanIp}${port ? `:${port}` : ''}`;
  }
  return window.location.origin;
}
