-- ═══════════════════════════════════════════════════════════════════════
--  Naran DSD · prueba de las políticas RLS
--  Ejecutar en Supabase → SQL Editor DESPUÉS de 01 y 02.
--  Crea dos clínicas y tres usuarios falsos, comprueba el aislamiento y
--  deshace todo. No toca los datos reales (corre dentro de una transacción
--  que termina en ROLLBACK).
-- ═══════════════════════════════════════════════════════════════════════
begin;

do $$
declare
  cli_a uuid; cli_b uuid;
  u_dent uuid := gen_random_uuid();
  u_ejec uuid := gen_random_uuid();
  u_otra uuid := gen_random_uuid();
  caso_a uuid;
  n int;
  fallo text;
begin
  -- Usuarios de mentira en auth.users (la FK de perfiles los exige)
  insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
  values (u_dent,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-dent@test.local','x',now(),now(),now()),
         (u_ejec,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-ejec@test.local','x',now(),now(),now()),
         (u_otra,'00000000-0000-0000-0000-000000000000','authenticated','authenticated','t-otra@test.local','x',now(),now(),now());

  insert into public.clinicas (nombre) values ('TEST Clínica A') returning id into cli_a;
  insert into public.clinicas (nombre) values ('TEST Clínica B') returning id into cli_b;

  insert into public.perfiles (id, clinica_id, nombre, rol) values
    (u_dent, cli_a, 'Dentista A', 'dentista'),
    (u_ejec, cli_a, 'Ejecutivo A','ejecutivo'),
    (u_otra, cli_b, 'Dentista B', 'dentista');

  insert into public.casos (clinica_id, creado_por, paciente_nombre)
    values (cli_a, u_dent, 'Paciente A') returning id into caso_a;

  -- ── A partir de aquí actuamos como los usuarios ──────────────────────
  set local role authenticated;

  -- 1. El dentista de A ve su caso
  perform set_config('request.jwt.claims', json_build_object('sub',u_dent,'role','authenticated')::text, true);
  select count(*) into n from public.casos;
  if n <> 1 then raise exception 'FALLA 1: el dentista de A debería ver 1 caso, ve %', n; end if;
  raise notice 'OK 1 · el dentista ve los casos de su clínica (%)', n;

  -- 2. El dentista de OTRA clínica no ve nada
  perform set_config('request.jwt.claims', json_build_object('sub',u_otra,'role','authenticated')::text, true);
  select count(*) into n from public.casos;
  if n <> 0 then raise exception 'FALLA 2: otra clínica ve % casos ajenos', n; end if;
  raise notice 'OK 2 · otra clínica no ve ningún caso ajeno';

  -- 3. …ni puede escribir en la clínica ajena
  begin
    update public.casos set paciente_nombre = 'hackeado' where id = caso_a;
    get diagnostics n = row_count;
    if n > 0 then raise exception 'FALLA 3: otra clínica modificó % filas ajenas', n; end if;
    raise notice 'OK 3 · otra clínica no puede modificar casos ajenos';
  end;

  -- 4. …ni insertar un caso dentro de la clínica A
  begin
    insert into public.casos (clinica_id, creado_por, paciente_nombre)
      values (cli_a, u_otra, 'Intruso');
    raise exception 'FALLA 4: se pudo insertar un caso en una clínica ajena';
  exception when insufficient_privilege or check_violation then
    raise notice 'OK 4 · no se puede insertar en una clínica ajena';
  end;

  -- 5. El ejecutivo lee, pero no escribe
  perform set_config('request.jwt.claims', json_build_object('sub',u_ejec,'role','authenticated')::text, true);
  select count(*) into n from public.casos;
  if n <> 1 then raise exception 'FALLA 5a: el ejecutivo debería leer 1 caso, lee %', n; end if;
  update public.casos set estado = 'entregado' where id = caso_a;
  get diagnostics n = row_count;
  if n > 0 then raise exception 'FALLA 5b: el ejecutivo modificó % casos', n; end if;
  raise notice 'OK 5 · el ejecutivo lee pero no modifica';

  -- 6. El dentista no puede borrar (solo admin)
  perform set_config('request.jwt.claims', json_build_object('sub',u_dent,'role','authenticated')::text, true);
  delete from public.casos where id = caso_a;
  get diagnostics n = row_count;
  if n > 0 then raise exception 'FALLA 6: el dentista borró % casos', n; end if;
  raise notice 'OK 6 · el dentista no puede borrar casos';

  -- 7. Nadie se auto-asciende a admin
  begin
    update public.perfiles set rol = 'admin' where id = u_dent;
    raise exception 'FALLA 7: un dentista se ascendió a admin';
  exception when raise_exception then
    if sqlerrm like 'FALLA 7%' then raise; end if;
    raise notice 'OK 7 · el trigger bloquea la auto-promoción a admin';
  end;

  -- 8. Sin sesión (anon) no se ve nada
  reset role;
  set local role anon;
  begin
    select count(*) into n from public.casos;
    if n > 0 then raise exception 'FALLA 8: anon ve % casos', n; end if;
    raise notice 'OK 8 · sin sesión no hay datos (0 filas)';
  exception when insufficient_privilege then
    raise notice 'OK 8 · sin sesión ni siquiera hay permiso de lectura';
  end;

  reset role;
  raise notice '───────── TODAS LAS PRUEBAS RLS PASARON ─────────';
end $$;

rollback;
