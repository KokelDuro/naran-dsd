-- ═══════════════════════════════════════════════════════════════════════
--  Naran DSD · esquema + RLS
--  Ejecutar en Supabase → SQL Editor. Idempotente: se puede correr de nuevo.
--
--  Principio: TODA fila pertenece a una clínica. Nadie ve filas de otra
--  clínica, ni siquiera con la anon key en la mano. El rol decide qué puede
--  escribir dentro de la propia clínica.
-- ═══════════════════════════════════════════════════════════════════════

create extension if not exists pgcrypto;
create schema if not exists app;

-- ── Tenant ─────────────────────────────────────────────────────────────
create table if not exists public.clinicas (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  creada_en  timestamptz not null default now()
);

do $$ begin
  create type public.rol_usuario as enum ('admin','dentista','ejecutivo');
exception when duplicate_object then null; end $$;

-- ── Usuarios (1:1 con auth.users) ──────────────────────────────────────
create table if not exists public.perfiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  clinica_id  uuid not null references public.clinicas(id) on delete restrict,
  nombre      text not null,
  rol         public.rol_usuario not null default 'dentista',
  activo      boolean not null default true,
  creado_en   timestamptz not null default now()
);
create index if not exists perfiles_clinica_idx on public.perfiles (clinica_id);

-- ── Helpers SECURITY DEFINER ───────────────────────────────────────────
-- Leen `perfiles` saltándose RLS. Sin esto, una policy sobre `perfiles` que
-- consulte `perfiles` entra en recursión infinita.
create or replace function app.clinica_id()
returns uuid language sql stable security definer set search_path = public, pg_temp as $$
  select p.clinica_id from public.perfiles p where p.id = auth.uid() and p.activo
$$;

create or replace function app.rol()
returns public.rol_usuario language sql stable security definer set search_path = public, pg_temp as $$
  select p.rol from public.perfiles p where p.id = auth.uid() and p.activo
$$;

create or replace function app.es(roles public.rol_usuario[])
returns boolean language sql stable as $$ select app.rol() = any(roles) $$;

revoke all on function app.clinica_id(), app.rol(), app.es(public.rol_usuario[]) from public, anon;
grant execute on function app.clinica_id(), app.rol(), app.es(public.rol_usuario[]) to authenticated;

-- ── Casos ──────────────────────────────────────────────────────────────
-- `datos` guarda el JSON del caso: textos del DSD, plan clínico, propuesta
-- por fases, perfil de venta, storyboard de láminas y parámetros de pago.
-- NO guarda audios ni fotos del paciente (ver §Privacidad del FLUJO).
create table if not exists public.casos (
  id               uuid primary key default gen_random_uuid(),
  clinica_id       uuid not null default app.clinica_id() references public.clinicas(id) on delete cascade,
  creado_por       uuid not null default auth.uid() references public.perfiles(id) on delete set default,
  paciente_nombre  text not null check (length(trim(paciente_nombre)) > 0),
  paciente_edad    int check (paciente_edad between 0 and 120),
  fecha_consulta   date,
  estado           text not null default 'borrador'
                     check (estado in ('borrador','revisado','entregado')),
  datos            jsonb not null default '{}'::jsonb,
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz not null default now()
);
create index if not exists casos_clinica_fecha_idx on public.casos (clinica_id, creado_en desc);

-- ── Correcciones (aprendizaje) ─────────────────────────────────────────
-- Lo que la IA propuso vs. lo que el dentista dejó. Se reinyecta como
-- ejemplos en el siguiente análisis. Sin nombre de paciente.
create table if not exists public.correcciones (
  id           uuid primary key default gen_random_uuid(),
  clinica_id   uuid not null default app.clinica_id() references public.clinicas(id) on delete cascade,
  caso_id      uuid references public.casos(id) on delete set null,
  campo        text not null,
  valor_ia     text,
  valor_final  text,
  creado_en    timestamptz not null default now()
);
create index if not exists correcciones_clinica_idx on public.correcciones (clinica_id, creado_en desc);

-- ── Parámetros de pago por clínica ─────────────────────────────────────
create table if not exists public.parametros_pago (
  clinica_id        uuid primary key references public.clinicas(id) on delete cascade,
  dscto_contado     numeric(5,2) not null default 10 check (dscto_contado between 0 and 100),
  cuotas_tarjeta    int          not null default 12 check (cuotas_tarjeta between 1 and 48),
  pie_pct           numeric(5,2) not null default 30 check (pie_pct between 0 and 100),
  cuotas_internas   int          not null default 6  check (cuotas_internas between 1 and 48),
  actualizado_en    timestamptz  not null default now()
);

-- ── Archivos generados (opcional; ver §Storage) ────────────────────────
create table if not exists public.archivos (
  id          uuid primary key default gen_random_uuid(),
  clinica_id  uuid not null default app.clinica_id() references public.clinicas(id) on delete cascade,
  caso_id     uuid not null references public.casos(id) on delete cascade,
  tipo        text not null check (tipo in ('dsd_pptx','dsd_pdf','propuesta_pptx','propuesta_pdf','tips_pdf','plan_pdf','fases_pdf','caso_json')),
  path        text not null unique,
  bytes       bigint,
  creado_en   timestamptz not null default now()
);
create index if not exists archivos_caso_idx on public.archivos (caso_id);

-- ── Bitácora de uso de IA (cuota diaria de Gemini) ─────────────────────
create table if not exists public.analisis_log (
  id           bigserial primary key,
  clinica_id   uuid not null default app.clinica_id() references public.clinicas(id) on delete cascade,
  usuario_id   uuid not null default auth.uid(),
  caso_id      uuid references public.casos(id) on delete set null,
  modelo       text,
  ok           boolean not null default true,
  detalle      text,
  creado_en    timestamptz not null default now()
);
create index if not exists analisis_log_clinica_dia_idx on public.analisis_log (clinica_id, creado_en desc);

-- ── actualizado_en automático ──────────────────────────────────────────
create or replace function app.touch()
returns trigger language plpgsql as $$
begin new.actualizado_en = now(); return new; end $$;

drop trigger if exists casos_touch on public.casos;
create trigger casos_touch before update on public.casos
  for each row execute function app.touch();

-- ── Antiescalada de privilegios ────────────────────────────────────────
-- Un usuario no puede cambiarse el rol ni mudarse de clínica editando su
-- propia fila. Solo un admin de la misma clínica puede.
create or replace function app.protege_perfil()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if (new.rol is distinct from old.rol or new.clinica_id is distinct from old.clinica_id
      or new.activo is distinct from old.activo)
     and not (app.rol() = 'admin' and app.clinica_id() = old.clinica_id) then
    raise exception 'Solo un admin de la clínica puede cambiar rol, clínica o estado activo';
  end if;
  return new;
end $$;

drop trigger if exists perfiles_protege on public.perfiles;
create trigger perfiles_protege before update on public.perfiles
  for each row execute function app.protege_perfil();


-- ═══════════════════════════════════════════════════════════════════════
--  RLS
-- ═══════════════════════════════════════════════════════════════════════
alter table public.clinicas        enable row level security;
alter table public.perfiles        enable row level security;
alter table public.casos           enable row level security;
alter table public.correcciones    enable row level security;
alter table public.parametros_pago enable row level security;
alter table public.archivos        enable row level security;
alter table public.analisis_log    enable row level security;

-- FORCE: las policies aplican también al dueño de la tabla.
alter table public.clinicas        force row level security;
alter table public.perfiles        force row level security;
alter table public.casos           force row level security;
alter table public.correcciones    force row level security;
alter table public.parametros_pago force row level security;
alter table public.archivos        force row level security;
alter table public.analisis_log    force row level security;

-- El rol anónimo no toca nada: sin sesión iniciada no hay datos.
revoke all on all tables in schema public from anon;
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;

-- ── clinicas ───────────────────────────────────────────────────────────
drop policy if exists clinicas_select on public.clinicas;
create policy clinicas_select on public.clinicas for select to authenticated
  using (id = app.clinica_id());
-- Crear/borrar clínicas: solo desde el panel de Supabase (service_role).

-- ── perfiles ───────────────────────────────────────────────────────────
drop policy if exists perfiles_select on public.perfiles;
create policy perfiles_select on public.perfiles for select to authenticated
  using (clinica_id = app.clinica_id());

drop policy if exists perfiles_update on public.perfiles;
create policy perfiles_update on public.perfiles for update to authenticated
  using (id = auth.uid() or (app.es(array['admin']::public.rol_usuario[]) and clinica_id = app.clinica_id()))
  with check (clinica_id = app.clinica_id());   -- el trigger bloquea el cambio de rol

drop policy if exists perfiles_insert on public.perfiles;
create policy perfiles_insert on public.perfiles for insert to authenticated
  with check (app.es(array['admin']::public.rol_usuario[]) and clinica_id = app.clinica_id());

-- ── casos ──────────────────────────────────────────────────────────────
-- Todos los de la clínica LEEN (el ejecutivo necesita abrir el caso para
-- bajar sus PDFs). Solo admin y dentista ESCRIBEN. Solo admin BORRA.
drop policy if exists casos_select on public.casos;
create policy casos_select on public.casos for select to authenticated
  using (clinica_id = app.clinica_id());

drop policy if exists casos_insert on public.casos;
create policy casos_insert on public.casos for insert to authenticated
  with check (clinica_id = app.clinica_id()
              and creado_por = auth.uid()
              and app.es(array['admin','dentista']::public.rol_usuario[]));

drop policy if exists casos_update on public.casos;
create policy casos_update on public.casos for update to authenticated
  using (clinica_id = app.clinica_id() and app.es(array['admin','dentista']::public.rol_usuario[]))
  with check (clinica_id = app.clinica_id());

drop policy if exists casos_delete on public.casos;
create policy casos_delete on public.casos for delete to authenticated
  using (clinica_id = app.clinica_id() and app.es(array['admin']::public.rol_usuario[]));

-- ── correcciones ───────────────────────────────────────────────────────
drop policy if exists correcciones_select on public.correcciones;
create policy correcciones_select on public.correcciones for select to authenticated
  using (clinica_id = app.clinica_id());

drop policy if exists correcciones_insert on public.correcciones;
create policy correcciones_insert on public.correcciones for insert to authenticated
  with check (clinica_id = app.clinica_id() and app.es(array['admin','dentista']::public.rol_usuario[]));

drop policy if exists correcciones_delete on public.correcciones;
create policy correcciones_delete on public.correcciones for delete to authenticated
  using (clinica_id = app.clinica_id() and app.es(array['admin']::public.rol_usuario[]));

-- ── parametros_pago ────────────────────────────────────────────────────
drop policy if exists parametros_select on public.parametros_pago;
create policy parametros_select on public.parametros_pago for select to authenticated
  using (clinica_id = app.clinica_id());

drop policy if exists parametros_write on public.parametros_pago;
create policy parametros_write on public.parametros_pago for all to authenticated
  using (clinica_id = app.clinica_id() and app.es(array['admin']::public.rol_usuario[]))
  with check (clinica_id = app.clinica_id() and app.es(array['admin']::public.rol_usuario[]));

-- ── archivos ───────────────────────────────────────────────────────────
drop policy if exists archivos_select on public.archivos;
create policy archivos_select on public.archivos for select to authenticated
  using (clinica_id = app.clinica_id());

drop policy if exists archivos_insert on public.archivos;
create policy archivos_insert on public.archivos for insert to authenticated
  with check (clinica_id = app.clinica_id()
              and exists (select 1 from public.casos c
                          where c.id = caso_id and c.clinica_id = app.clinica_id()));

drop policy if exists archivos_delete on public.archivos;
create policy archivos_delete on public.archivos for delete to authenticated
  using (clinica_id = app.clinica_id() and app.es(array['admin','dentista']::public.rol_usuario[]));

-- ── analisis_log ───────────────────────────────────────────────────────
drop policy if exists log_select on public.analisis_log;
create policy log_select on public.analisis_log for select to authenticated
  using (clinica_id = app.clinica_id());

drop policy if exists log_insert on public.analisis_log;
create policy log_insert on public.analisis_log for insert to authenticated
  with check (clinica_id = app.clinica_id() and usuario_id = auth.uid());
-- Nadie actualiza ni borra la bitácora (no hay policy de update/delete).


-- ═══════════════════════════════════════════════════════════════════════
--  Storage (bucket privado `casos`)
--  Convención de ruta:  <clinica_id>/<caso_id>/<archivo>
--  La primera carpeta ES la llave de aislamiento.
-- ═══════════════════════════════════════════════════════════════════════
insert into storage.buckets (id, name, public)
values ('casos','casos',false)
on conflict (id) do update set public = false;

drop policy if exists casos_obj_select on storage.objects;
create policy casos_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'casos' and (storage.foldername(name))[1] = app.clinica_id()::text);

drop policy if exists casos_obj_insert on storage.objects;
create policy casos_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'casos' and (storage.foldername(name))[1] = app.clinica_id()::text);

drop policy if exists casos_obj_update on storage.objects;
create policy casos_obj_update on storage.objects for update to authenticated
  using (bucket_id = 'casos' and (storage.foldername(name))[1] = app.clinica_id()::text)
  with check (bucket_id = 'casos' and (storage.foldername(name))[1] = app.clinica_id()::text);

drop policy if exists casos_obj_delete on storage.objects;
create policy casos_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'casos' and (storage.foldername(name))[1] = app.clinica_id()::text
         and app.es(array['admin','dentista']::public.rol_usuario[]));
