-- ═══════════════════════════════════════════════════════════════════════
--  Naran DSD · el archivo del caso también guarda los audios
--  Ejecutar DESPUÉS de 05_archivos.sql, en Supabase → SQL Editor.
--
--  Para poder volver a analizar un caso, sus audios de la consulta se
--  guardan junto con las fotos, en <clinica>/<caso>/aud/. Las políticas
--  del bucket no cambian: la primera carpeta sigue siendo la clínica.
--
--  Límite: 50 MB por archivo, que es el máximo del plan gratis de
--  Supabase. Un audio más pesado (un video largo, por ejemplo) se queda
--  solo en el equipo donde se trabajó, y la página lo avisa.
-- ═══════════════════════════════════════════════════════════════════════

update storage.buckets
   set file_size_limit    = 52428800,          -- 50 MB
       allowed_mime_types = array[
         'image/jpeg','image/png','image/webp',
         'application/pdf',
         'application/vnd.openxmlformats-officedocument.presentationml.presentation',
         'application/json',
         'audio/*','video/*',
         'application/octet-stream'
       ]
 where id = 'casos';

-- ── Comprobar ──────────────────────────────────────────────────────────
-- select id, file_size_limit, allowed_mime_types from storage.buckets where id = 'casos';
--
-- Ojo con el espacio: el plan gratis trae 1 GB en total. Un audio de una
-- consulta pesa entre 20 y 40 MB, así que caben unos 25 a 40 casos con
-- audio. Para ver cuánto se usa: Supabase → Storage → casos.
