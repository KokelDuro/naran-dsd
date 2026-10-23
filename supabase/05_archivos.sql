-- ═══════════════════════════════════════════════════════════════════════
--  Naran DSD · archivos del caso (fotos y documentos)
--  Ejecutar DESPUÉS de 01 y 02, en Supabase → SQL Editor.
--
--  Idea: las fotos y los PDF de cada caso viven en un bucket privado, con
--  la ruta  <clinica_id>/<caso_id>/<archivo>.  La política mira la PRIMERA
--  carpeta de la ruta y la compara con la clínica de quien pregunta: así
--  el dentista y su ejecutivo ven lo mismo, y nadie ve lo de otra clínica.
--
--  El bucket es privado: no hay URL pública. El navegador descarga con la
--  sesión del usuario, y Storage aplica estas políticas en cada lectura.
-- ═══════════════════════════════════════════════════════════════════════

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'casos', 'casos', false,
  26214400,                                   -- 25 MB por archivo
  array[
    'image/jpeg','image/png','image/webp',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/json'
  ]
)
on conflict (id) do update
  set public             = false,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── Políticas ──────────────────────────────────────────────────────────
-- storage.foldername('<clinica>/<caso>/foto.jpg') → {<clinica>,<caso>}

drop policy if exists casos_archivos_ver      on storage.objects;
drop policy if exists casos_archivos_subir    on storage.objects;
drop policy if exists casos_archivos_cambiar  on storage.objects;
drop policy if exists casos_archivos_borrar   on storage.objects;

create policy casos_archivos_ver on storage.objects
  for select to authenticated
  using (
    bucket_id = 'casos'
    and (storage.foldername(name))[1] = app.clinica_id()::text
  );

create policy casos_archivos_subir on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'casos'
    and (storage.foldername(name))[1] = app.clinica_id()::text
  );

create policy casos_archivos_cambiar on storage.objects
  for update to authenticated
  using (
    bucket_id = 'casos'
    and (storage.foldername(name))[1] = app.clinica_id()::text
  )
  with check (
    bucket_id = 'casos'
    and (storage.foldername(name))[1] = app.clinica_id()::text
  );

create policy casos_archivos_borrar on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'casos'
    and (storage.foldername(name))[1] = app.clinica_id()::text
  );

-- ── Comprobar ──────────────────────────────────────────────────────────
-- Con la sesión de un usuario de la clínica, desde la página:
--   SB.storage.from('casos').list('<clinica_id>')      → ve sus carpetas
--   SB.storage.from('casos').list('<otra_clinica>')    → vacío
--
-- Si quisieras que el ejecutivo viera solo documentos y no fotos clínicas,
-- la política de lectura llevaría además:
--   and (app.rol() <> 'ejecutivo' or name like '%/doc/%')
