# Despliegue — Naran DSD

Arquitectura elegida: **Cloudflare Workers** (la app y la API) + **Supabase** (sesión, base de datos con RLS). Ambos en plan gratuito.

> **Por qué las dos cosas:** RLS (*Row Level Security*) es una función de Postgres, y Cloudflare no tiene Postgres — su base de datos (D1) es SQLite y **no soporta RLS**. Si quieres RLS de verdad, los datos van en Supabase. Cloudflare sigue siendo lo que sirve la página, esconde la API key de Gemini y pone el dominio.

| Capa | Dónde | Plan |
|---|---|---|
| Página (HTML/CSS/JS) | Cloudflare Workers + assets estáticos | gratis |
| `/api/analizar` (proxy a Gemini, esconde la key) | Cloudflare Workers | gratis (100.000 req/día) |
| Sesión y usuarios | Supabase Auth | gratis |
| Casos, correcciones, parámetros | Supabase Postgres **con RLS** | gratis (500 MB) |
| Archivos generados (opcional) | Supabase Storage, bucket privado | gratis (1 GB) |
| Audios y fotos del paciente | **no se guardan**: del navegador van a Gemini y se descartan | — |

---

## 1. Qué necesito de ti

No puedo crear cuentas a tu nombre. Estos tres pasos los haces tú una sola vez:

1. **Cuenta de Cloudflare** (gratis, sin tarjeta) → dash.cloudflare.com
2. **Cuenta de Supabase** (gratis) → supabase.com → nuevo proyecto, región `South America (São Paulo)`. Guarda la contraseña de la base.
3. **API key de Gemini** → aistudio.google.com → *Get API key*.

Cuando las tengas, pásame: la **URL del proyecto Supabase**, la **anon key** (esa es pública, no hay problema) y me dices que la **API key de Gemini** ya la cargaste como secreto. **La key de Gemini no me la pegues en el chat**: se carga directo en Cloudflare (paso 3).

---

## 2. Base de datos y RLS

En Supabase → **SQL Editor**, corre en orden:

1. `supabase/01_schema.sql` — tablas, roles y **todas las políticas RLS**.
2. `supabase/02_seed.sql` — crea la clínica y la función `enrolar(...)`.
3. En **Authentication → Users → Add user**, crea los usuarios (correo + contraseña). Luego, en SQL Editor:
   ```sql
   select public.enrolar('jorge@ejemplo.cl',   'Jorge Bustamante', 'admin');
   select public.enrolar('dentista@ejemplo.cl','Dra. …',           'dentista');
   select public.enrolar('ventas@ejemplo.cl',  'Ejecutivo …',      'ejecutivo');
   ```
4. `supabase/03_test_rls.sql` — **prueba las políticas y deshace todo** (termina en `rollback`). Debe imprimir `TODAS LAS PRUEBAS RLS PASARON`. Si alguna falla, no sigas: avísame.

### Qué garantizan las políticas

| Regla | Cómo se cumple |
|---|---|
| Nadie ve datos de otra clínica | Cada tabla filtra por `clinica_id = app.clinica_id()`, que sale del perfil del usuario autenticado |
| Sin sesión no hay datos | Al rol `anon` se le revocan todos los permisos; la anon key sola no sirve de nada |
| El ejecutivo lee pero no edita | `select` para todos los de la clínica; `insert`/`update` solo para `admin` y `dentista` |
| Solo el admin borra casos | `delete` restringido a `admin` |
| Nadie se asciende a admin | Trigger `protege_perfil` bloquea cambios de `rol`, `clinica_id` y `activo` salvo que los haga un admin |
| Los archivos del caso no se cruzan | Bucket privado; la ruta es `<clinica_id>/<caso_id>/archivo` y la política compara la primera carpeta con la clínica del usuario |
| La bitácora no se puede borrar | `analisis_log` tiene policy de `insert` y `select`, ninguna de `update`/`delete` |
| Las policies aplican al dueño de la tabla | `force row level security` en todas |

---

## 3. Publicar en Cloudflare

El proyecto es un **Worker con assets estáticos** (`[assets] directory = "./public"` en `wrangler.toml`): Cloudflare sirve la app desde `public/` y todo lo que no sea un archivo estático llega a `src/index.js`, que atiende `/api/*`. Por eso **no existe el campo "Build output directory"**: ese es de Pages, no de Workers.

### Opción A · conectado a GitHub (la que estamos usando)

En Workers & Pages → tu proyecto → Settings → Build:

| Campo | Valor |
|---|---|
| Build command | *(vacío)* |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |
| Non-production branch deploy command | *(vacío o el mismo)* |

Cada `git push` a `main` dispara un deploy. La URL queda como `https://naran-dsd.<tu-subdominio>.workers.dev`.

> **Si el build falla en "Cloning repository"**, el repositorio está vacío o Cloudflare no tiene acceso: haz el primer `git push` y dale *Retry build*.

### Opción B · desde tu equipo

Requiere Node.js, que en este equipo **no está instalado**. Una sola vez:

```bash
winget install OpenJS.NodeJS.LTS
```

Cierra y reabre la terminal, y desde `Pagina naran/app`:

```bash
npx wrangler deploy
```

### Variables y secretos

```bash
npx wrangler secret put GEMINI_API_KEY
```

y en el panel (Settings → Variables and Secrets) agrega como texto normal:

- `SUPABASE_URL` → `https://xxxxxxxx.supabase.co`
- `SUPABASE_ANON_KEY` → `eyJ…`
- `GEMINI_MODEL` → déjala vacía; el Worker elige solo un modelo Flash disponible.

Para probar localmente antes de publicar: `npx wrangler dev`.

### Comprobar que quedó bien

Abre `https://naran-dsd.<tu-subdominio>.workers.dev/api/salud`. Devuelve qué está configurado (sin mostrar ningún valor) y la lista de modelos Gemini que acepta tu key. Si `gemini_key` sale en `false`, el secreto no quedó cargado.

## 4. Estado de esta entrega

| Parte | Estado |
|---|---|
| Interfaz completa (5 pasos + historial) | ✅ lista, con datos de ejemplo |
| Lectura del PDF de Dentalink en el navegador | ✅ funciona |
| Vistas previas de láminas y PDFs | ✅ funcionan |
| Esquema + RLS + pruebas | ✅ escritos, faltan correr en tu proyecto |
| `/api/analizar` (audio → JSON) | ✅ escrito, falta la key para probarlo de verdad |
| Pantalla de inicio de sesión | ⏳ siguiente paso |
| Guardar/leer casos en Supabase | ⏳ siguiente paso |
| Generación real de .pptx y .pdf | ⏳ siguiente paso |

Es decir: lo que subes ahora sirve para **probar el flujo y el diseño en el teléfono y en la clínica**, no todavía para procesar un paciente real de punta a punta.

---

## 5. Antes de usarlo con pacientes reales

- El consentimiento informado de la clínica debe cubrir que el audio de la consulta y las fotos se procesan con un servicio de IA (Google Gemini).
- En el plan gratuito de Gemini, Google **puede usar** el contenido enviado para mejorar sus modelos. Si eso no es aceptable para la clínica, hay que pasar Gemini a pago por uso (centavos por caso) — no cambia ni una línea de la app, solo la facturación de la key.
- A Gemini solo se envían los audios, las fotos y el **nombre de pila**. Nunca RUT, apellido, teléfono ni correo.
