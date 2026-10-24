-- ═══════════════════════════════════════════════════════════════════════
--  Naran DSD · el ejecutivo puede guardar el presupuesto en el caso
--  Ejecutar DESPUÉS de 01, 02 y 04, en Supabase → SQL Editor.
--
--  El flujo del ejecutivo: abre el caso, lee el plan clínico y la
--  propuesta por fases, arma el presupuesto en Dentalink y lo trae a la
--  página. Para que ese presupuesto quede guardado en el caso, su rol
--  necesita poder ACTUALIZAR casos de su clínica.
--
--  Sigue sin poder crear casos nuevos ni borrarlos: eso es de admin y
--  dentista. En la página, además, solo ve el historial y el paso de la
--  propuesta; los textos y las láminas no se le muestran para editar.
-- ═══════════════════════════════════════════════════════════════════════

drop policy if exists casos_update on public.casos;
create policy casos_update on public.casos for update to authenticated
  using (
    clinica_id = app.clinica_id()
    and app.es(array['admin','dentista','ejecutivo']::public.rol_usuario[])
  )
  with check (clinica_id = app.clinica_id());

-- ── Comprobar ──────────────────────────────────────────────────────────
-- select policyname, cmd, qual from pg_policies
--  where tablename = 'casos' and policyname = 'casos_update';
-- Debe mencionar 'ejecutivo' en la condición.
