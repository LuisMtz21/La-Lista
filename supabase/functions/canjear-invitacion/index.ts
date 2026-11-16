import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getAuthenticatedUser, jsonResponse, corsHeaders } from '../_shared/auth.ts';

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Método no permitido.' }, 405);

  try {
    const { authorization, supabaseUrl, anonKey } = await getAuthenticatedUser(request);
    const body = await request.json();
    const token = typeof body.codigo === 'string' ? body.codigo.trim() : '';
    const deviceName = typeof body.nombreDispositivo === 'string' ? body.nombreDispositivo.trim() : '';
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) {
      return jsonResponse({ error: 'La invitación no es válida o ha vencido.' }, 400);
    }

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: spaceId, error } = await userClient.rpc('canjear_invitacion', {
      p_token_hash: await hashToken(token),
      p_nombre_dispositivo: deviceName.slice(0, 80) || 'Dispositivo',
    });
    if (error) {
      console.error('canjear-invitacion RPC:', error);
      if (error.code === 'P0001') {
        return jsonResponse({
          error: 'La invitación ya se usó o venció. Pide que generen un enlace nuevo desde un dispositivo vinculado.'
        }, 400);
      }
      return jsonResponse({
        error: 'No se pudo vincular el dispositivo. Verifica que este no esté vinculado a otro espacio y solicita otra invitación si hace falta.'
      }, 400);
    }

    return jsonResponse({ espacioId: spaceId });
  } catch (error) {
    console.error('canjear-invitacion:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'No se pudo vincular el dispositivo.' }, 400);
  }
});
