import { getAdminClient, getAuthenticatedUser, jsonResponse, corsHeaders } from '../_shared/auth.ts';

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return jsonResponse({ error: 'Método no permitido.' }, 405);

  try {
    const { user, supabaseUrl } = await getAuthenticatedUser(request);
    const admin = getAdminClient(supabaseUrl);
    const { data: existingDevice, error: lookupError } = await admin
      .from('dispositivos')
      .select('espacio_id')
      .eq('auth_user_id', user.id)
      .is('revocado_en', null)
      .maybeSingle();

    if (lookupError) throw lookupError;
    if (existingDevice) return jsonResponse({ espacioId: existingDevice.espacio_id });

    const { data: space, error: spaceError } = await admin
      .from('espacios')
      .insert({})
      .select('id')
      .single();
    if (spaceError) throw spaceError;

    const { error: deviceError } = await admin.from('dispositivos').insert({
      espacio_id: space.id,
      auth_user_id: user.id,
      nombre_dispositivo: 'Este dispositivo',
    });
    if (deviceError) throw deviceError;

    return jsonResponse({ espacioId: space.id });
  } catch (error) {
    console.error('crear-espacio:', error);
    return jsonResponse({ error: error instanceof Error ? error.message : 'No se pudo crear el espacio.' }, 400);
  }
});
