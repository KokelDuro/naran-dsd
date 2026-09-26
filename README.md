# Naran DSD

App interna de Naran Estudio Dental. Convierte la carpeta de una primera consulta (audios + fotos) en los documentos que hoy se arman a mano:

| Documento | Para quién | Formato |
|---|---|---|
| DSD | Paciente | .pptx + .pdf |
| Propuesta (plan por fases + formas de pago) | Paciente | .pptx + .pdf |
| Plan clínico para valorización | Ejecutivo | .pdf |
| Propuesta por fases | Ejecutivo | .pdf |
| EC-01 · Tips de venta + Perfil DISC | Ejecutivo | .pdf |

**La IA no diagnostica.** Ordena y redacta lo que se dijo en la consulta; el plan clínico sale de lo que dijo el dentista y él lo revisa y aprueba antes de generar nada. Los precios vienen del presupuesto de Dentalink, nunca del modelo.

## Cómo está armado

```
public/          la app (una sola página, sin framework) — servida como assets
  index.html
  _headers       cabeceras de seguridad
src/             el Worker
  index.js       enruta /api/*; el resto lo sirven los assets
  analizar.js    audios + fotos → Gemini → JSON del caso (esconde la API key)
  salud.js       diagnóstico de configuración
supabase/        esquema, datos iniciales y pruebas de RLS
  01_schema.sql  tablas + políticas
  02_seed.sql    clínica y función enrolar()
  03_test_rls.sql pruebas de aislamiento (termina en rollback)
DESPLIEGUE.md    paso a paso para publicar
```

- **Página y API:** un Worker de Cloudflare con assets estáticos.
- **Sesión y datos:** Supabase Auth + Postgres con RLS (una clínica, roles admin / dentista / ejecutivo).
- **IA:** Gemini Flash, plan gratuito. La key vive como secreto de Cloudflare.
- **Audios y fotos del paciente no se guardan:** van del navegador a Gemini para el análisis y se descartan. Lo único que persiste es el texto del caso.

## Datos de ejemplo

La app viene con un caso de demostración (paciente ficticio "Matías Rojas") para poder recorrer el flujo sin cargar nada. No corresponde a ninguna persona real.

Ver [DESPLIEGUE.md](DESPLIEGUE.md) para publicar y [../FLUJO-AUTOMATIZACION.md](../FLUJO-AUTOMATIZACION.md) para la definición completa del flujo.
