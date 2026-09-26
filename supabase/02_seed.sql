-- ═══════════════════════════════════════════════════════════════════════
--  Naran DSD · datos iniciales
--  Ejecutar DESPUÉS de 01_schema.sql, en Supabase → SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════

-- 1. La clínica
insert into public.clinicas (nombre)
select 'Naran Estudio Dental'
where not exists (select 1 from public.clinicas where nombre = 'Naran Estudio Dental');

insert into public.parametros_pago (clinica_id)
select id from public.clinicas where nombre = 'Naran Estudio Dental'
on conflict (clinica_id) do nothing;

-- 2. Enrolar usuarios
-- Crea primero el usuario en Supabase → Authentication → Users → Add user
-- (correo + contraseña), y después córrelo aquí con ese mismo correo.
create or replace function public.enrolar(
  p_email   text,
  p_nombre  text,
  p_rol     public.rol_usuario default 'dentista',
  p_clinica text default 'Naran Estudio Dental'
) returns uuid language plpgsql security definer set search_path = public, auth, pg_temp as $$
declare v_uid uuid; v_cli uuid;
begin
  select id into v_uid from auth.users where lower(email) = lower(p_email);
  if v_uid is null then
    raise exception 'No existe un usuario con el correo %. Créalo primero en Authentication → Users.', p_email;
  end if;
  select id into v_cli from public.clinicas where nombre = p_clinica;
  if v_cli is null then raise exception 'No existe la clínica %', p_clinica; end if;

  insert into public.perfiles (id, clinica_id, nombre, rol)
  values (v_uid, v_cli, p_nombre, p_rol)
  on conflict (id) do update set clinica_id = excluded.clinica_id,
                                 nombre     = excluded.nombre,
                                 rol        = excluded.rol,
                                 activo     = true;
  return v_uid;
end $$;

revoke all on function public.enrolar(text,text,public.rol_usuario,text) from public, anon, authenticated;

-- 3. Enrola a los tres (cambia los correos por los reales)
-- select public.enrolar('jorge@…',    'Jorge Bustamante', 'admin');
-- select public.enrolar('dentista@…', 'Dra. …',           'dentista');
-- select public.enrolar('ventas@…',   'Ejecutivo …',      'ejecutivo');

-- 4. Comprobación
-- select p.nombre, p.rol, c.nombre as clinica from public.perfiles p join public.clinicas c on c.id = p.clinica_id;
