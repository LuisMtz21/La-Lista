import { getAdminClient, getAuthenticatedUser, jsonResponse, corsHeaders } from '../_shared/auth.ts';

function createToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Método no permitido.' }, 405);

  try {
    const { user, supabaseUrl } = await getAuthenticatedUser(request);
    const admin = getAdminClient(supabaseUrl);
    const { data: device, error: deviceError } = await admin
      .from('dispositivos')
      .select('espacio_id')
      .eq('auth_user_id', user.id)
      .is('revocado_en', null)
      .maybeSingle();

    if (deviceError) throw deviceError;
    if (!device) return jsonResponse({ error: 'Este dispositivo no está vinculado a un espacio.' }, 403);

    const token = createToken();
    const tokenHash = await hashToken(token);
    const { error: inviteError } = await admin.from('invitaciones').insert({
      espacio_id: device.espacio_id,
      token_hash: tokenHash,
      creada_por: user.id,
      vence_en: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    });
    if (inviteError) throw inviteError;

    return jsonResponse({ codigo: token, expiraEn: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
  } catch (error) {
    console.error('crear-invitacion:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'No se pudo crear la invitación.' }, 400);
  }
});
