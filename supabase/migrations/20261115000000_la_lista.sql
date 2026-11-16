create extension if not exists pgcrypto with schema extensions;

create table public.espacios (
  id uuid primary key default gen_random_uuid(),
  fecha_creacion timestamptz not null default now()
);

create table public.dispositivos (
  id uuid primary key default gen_random_uuid(),
  espacio_id uuid not null references public.espacios(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  nombre_dispositivo text not null default 'Dispositivo',
  fecha_vinculacion timestamptz not null default now(),
  revocado_en timestamptz,
  unique (espacio_id, auth_user_id)
);

create index dispositivos_user_active_idx
  on public.dispositivos (auth_user_id, espacio_id)
  where revocado_en is null;

create unique index dispositivos_user_one_active_space_idx
  on public.dispositivos (auth_user_id)
  where revocado_en is null;

create table public.invitaciones (
  id uuid primary key default gen_random_uuid(),
  espacio_id uuid not null references public.espacios(id) on delete cascade,
  token_hash text not null unique,
  creada_por uuid not null references auth.users(id) on delete cascade,
  creada_en timestamptz not null default now(),
  vence_en timestamptz not null,
  canjeada_en timestamptz,
  canjeada_por uuid references auth.users(id) on delete set null
);

create table public.listas (
  id uuid primary key default gen_random_uuid(),
  espacio_id uuid not null references public.espacios(id) on delete cascade,
  titulo text not null check (length(btrim(titulo)) between 1 and 120),
  fecha_creacion timestamptz not null default now(),
  fecha_modificacion timestamptz not null default now(),
  archivada boolean not null default false
);

create index listas_espacio_fecha_idx
  on public.listas (espacio_id, fecha_creacion desc);

create table public.elementos (
  id uuid primary key default gen_random_uuid(),
  lista_id uuid not null references public.listas(id) on delete cascade,
  texto text not null check (length(btrim(texto)) between 1 and 500),
  completado boolean not null default false,
  orden integer not null default 0,
  fecha_creacion timestamptz not null default now(),
  fecha_modificacion timestamptz not null default now()
);

create index elementos_lista_orden_idx
  on public.elementos (lista_id, completado, orden, fecha_creacion);

create or replace function public.es_dispositivo_autorizado(p_espacio_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.dispositivos d
    where d.espacio_id = p_espacio_id
      and d.auth_user_id = (select auth.uid())
      and d.revocado_en is null
  );
$$;

revoke all on function public.es_dispositivo_autorizado(uuid) from public;
grant execute on function public.es_dispositivo_autorizado(uuid) to authenticated;

create or replace function public.canjear_invitacion(p_token_hash text, p_nombre_dispositivo text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid := auth.uid();
  v_espacio_id uuid;
begin
  if v_auth_user_id is null then
    raise exception 'Se requiere una sesión autenticada.';
  end if;

  select i.espacio_id
    into v_espacio_id
    from public.invitaciones i
   where i.token_hash = p_token_hash
     and i.canjeada_en is null
     and i.vence_en > now()
   for update;

  if v_espacio_id is null then
    raise exception 'La invitación no es válida o ha vencido.';
  end if;

  update public.invitaciones
     set canjeada_en = now(),
         canjeada_por = v_auth_user_id
   where token_hash = p_token_hash;

  insert into public.dispositivos (espacio_id, auth_user_id, nombre_dispositivo)
  values (v_espacio_id, v_auth_user_id, left(btrim(p_nombre_dispositivo), 80))
  on conflict (espacio_id, auth_user_id) do update
    set revocado_en = null,
        nombre_dispositivo = excluded.nombre_dispositivo,
        fecha_vinculacion = now();

  return v_espacio_id;
end;
$$;

revoke all on function public.canjear_invitacion(text, text) from public;
grant execute on function public.canjear_invitacion(text, text) to authenticated;

alter table public.espacios enable row level security;
alter table public.dispositivos enable row level security;
alter table public.invitaciones enable row level security;
alter table public.listas enable row level security;
alter table public.elementos enable row level security;

create policy "Los dispositivos ven su espacio"
  on public.espacios for select to authenticated
  using (public.es_dispositivo_autorizado(id));

create policy "Los dispositivos autorizados consultan dispositivos"
  on public.dispositivos for select to authenticated
  using (public.es_dispositivo_autorizado(espacio_id));

create policy "Los dispositivos revocan otros dispositivos"
  on public.dispositivos for update to authenticated
  using (
    public.es_dispositivo_autorizado(espacio_id)
    and auth_user_id <> (select auth.uid())
    and revocado_en is null
  )
  with check (
    public.es_dispositivo_autorizado(espacio_id)
    and auth_user_id <> (select auth.uid())
    and revocado_en is not null
  );

create policy "Los dispositivos autorizados gestionan listas"
  on public.listas for all to authenticated
  using (public.es_dispositivo_autorizado(espacio_id))
  with check (public.es_dispositivo_autorizado(espacio_id));

create policy "Los dispositivos autorizados gestionan elementos"
  on public.elementos for all to authenticated
  using (
    exists (
      select 1
      from public.listas l
      where l.id = lista_id
        and public.es_dispositivo_autorizado(l.espacio_id)
    )
  )
  with check (
    exists (
      select 1
      from public.listas l
      where l.id = lista_id
        and public.es_dispositivo_autorizado(l.espacio_id)
    )
  );

grant select on public.espacios, public.dispositivos to authenticated;
grant update (revocado_en) on public.dispositivos to authenticated;
grant select, insert, update, delete on public.listas, public.elementos to authenticated;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'listas'
  ) then
    alter publication supabase_realtime add table public.listas;
  end if;
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'elementos'
  ) then
    alter publication supabase_realtime add table public.elementos;
  end if;
end;
$$;
