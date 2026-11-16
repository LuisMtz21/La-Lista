drop index if exists public.dispositivos_user_one_active_space_idx;

create or replace function public.salir_espacio(p_espacio_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  if auth.uid() is null then
    raise exception 'Se requiere una sesión autenticada.';
  end if;

  update public.dispositivos
     set revocado_en = now()
   where espacio_id = p_espacio_id
     and auth_user_id = (select auth.uid())
     and revocado_en is null;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

revoke all on function public.salir_espacio(uuid) from public;
grant execute on function public.salir_espacio(uuid) to authenticated;
