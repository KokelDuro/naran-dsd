-- ═══════════════════════════════════════════════════════════════════════
--  Naran DSD · invitaciones
--  Ejecutar DESPUÉS de 01 y 02, en Supabase → SQL Editor.
--
--  Idea: el administrador autoriza un correo (una línea). La persona entra
--  a la página, crea su propia contraseña y queda dentro con el rol que se
--  le asignó. Quien no esté invitado puede registrarse, pero se queda sin
--  perfil — y sin perfil, RLS no le muestra ni una fila.
-- ═══════════════════════════════════════════════════════════════════════

create table if not exists public.invitaciones (
  email       text primary key,
  clinica_id  uuid not null references public.clinicas(id) on delete cascade,
  nombre      text not null,
  rol         public.rol_usuario not null default 'dentista',
  invitada_en timestamptz not null default now(),
  usada_en    timestamptz
);

alter table public.invitaciones enable row level security;
alter table public.invitaciones force  row level security;
revoke all on public.invitaciones from anon;

-- Solo un admin de la clínica maneja las invitaciones.
drop policy if exists invitaciones_admin on public.invitaciones;
create policy invitaciones_admin on public.invitaciones for all to authenticated
  using (clinica_id = app.clinica_id() and app.es(array['admin']::public.rol_usuario[]))
  with check (clinica_id = app.clinica_id() and app.es(array['admin']::public.rol_usuario[]));

-- ── Al crearse una cuenta, se busca su invitación ──────────────────────
create or replace function app.enrolar_invitado()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare inv public.invitaciones;
begin
  select * into inv
    from public.invitaciones
   where lower(email) = lower(new.email) and usada_en is null;

  -- Sin invitación no se crea perfil: la cuenta existe pero no ve nada.
  if inv.email is null then
    return new;
  end if;

  insert into public.perfiles (id, clinica_id, nombre, rol)
  values (new.id, inv.clinica_id, inv.nombre, inv.rol)
  on conflict (id) do nothing;

  update public.invitaciones set usada_en = now() where email = inv.email;
  return new;
end $$;

drop trigger if exists al_crear_usuario on auth.users;
create trigger al_crear_usuario
  after insert on auth.users
  for each row execute function app.enrolar_invitado();

-- ── Atajo para invitar ─────────────────────────────────────────────────
create or replace function public.invitar(
  p_email   text,
  p_nombre  text,
  p_rol     public.rol_usuario default 'dentista',
  p_clinica text default 'Naran Estudio Dental'
) returns text language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_cli uuid; v_uid uuid;
begin
  select id into v_cli from public.clinicas where nombre = p_clinica;
  if v_cli is null then raise exception 'No existe la clínica %', p_clinica; end if;

  insert into public.invitaciones (email, clinica_id, nombre, rol)
  values (lower(trim(p_email)), v_cli, p_nombre, p_rol)
  on conflict (email) do update set nombre = excluded.nombre,
                                    rol    = excluded.rol,
                                    usada_en = null;

  -- Si la persona ya tenía cuenta creada antes de invitarla, la enrolamos ya.
  select id into v_uid from auth.users where lower(email) = lower(trim(p_email));
  if v_uid is not null then
    insert into public.perfiles (id, clinica_id, nombre, rol)
    values (v_uid, v_cli, p_nombre, p_rol)
    on conflict (id) do update set clinica_id = excluded.clinica_id,
                                   nombre     = excluded.nombre,
                                   rol        = excluded.rol,
                                   activo     = true;
    update public.invitaciones set usada_en = now() where email = lower(trim(p_email));
    return p_email || ' ya tenía cuenta: quedó habilitada como ' || p_rol;
  end if;

  return p_email || ' invitado como ' || p_rol || '. Ya puede crear su acceso desde la página.';
end $$;

revoke all on function public.invitar(text,text,public.rol_usuario,text) from public, anon, authenticated;

-- ── Ejemplos ───────────────────────────────────────────────────────────
-- select public.invitar('dentista@clinicanaran.cl', 'Dra. …',      'dentista');
-- select public.invitar('ventas@clinicanaran.cl',   'Ejecutivo …', 'ejecutivo');
--
-- Ver quién está invitado y quién ya entró:
-- select email, nombre, rol, usada_en from public.invitaciones order by invitada_en desc;
