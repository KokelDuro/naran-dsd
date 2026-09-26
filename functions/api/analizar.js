/**
 * POST /api/analizar  ·  Cloudflare Pages Function
 *
 * Recibe los audios y las fotos de una consulta, los manda a Gemini y
 * devuelve el JSON estructurado del caso.
 *
 * La API key de Gemini vive SOLO aquí (secreto de Cloudflare). El navegador
 * nunca la ve. Antes de gastar cuota, se verifica que quien llama tenga
 * sesión iniciada en Supabase.
 *
 * Variables de entorno (Cloudflare → Settings → Environment variables):
 *   GEMINI_API_KEY   (secreto)   clave de Google AI Studio
 *   SUPABASE_URL     (texto)     https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY(texto)     anon/publishable key
 *   GEMINI_MODEL     (opcional)  p. ej. gemini-flash-latest
 */

const API = 'https://generativelanguage.googleapis.com';
const MAX_INLINE = 18 * 1024 * 1024; // sobre esto, va por la Files API

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/* ── 1. ¿Quién llama? ────────────────────────────────────────────────── */
async function usuario(request, env) {
  const auth = request.headers.get('authorization') || '';
  if (!auth.toLowerCase().startsWith('bearer ')) return null;
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { authorization: auth, apikey: env.SUPABASE_ANON_KEY },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return u && u.id ? u : null;
}

/* ── 2. Elegir modelo ────────────────────────────────────────────────── */
async function modelo(env) {
  if (env.GEMINI_MODEL) return env.GEMINI_MODEL;
  const r = await fetch(`${API}/v1beta/models?key=${env.GEMINI_API_KEY}&pageSize=200`);
  if (!r.ok) throw new Error(`No se pudo listar modelos (${r.status})`);
  const { models = [] } = await r.json();
  const usable = models.filter(
    (m) => (m.supportedGenerationMethods || []).includes('generateContent') && /flash/i.test(m.name),
  );
  // preferimos un alias estable ("-latest") y, si no hay, el primero que sirva
  const pick = usable.find((m) => /latest/.test(m.name)) || usable[0];
  if (!pick) throw new Error('Ningún modelo Flash disponible para esta clave');
  return pick.name.replace(/^models\//, '');
}

/* ── 3. Subir un archivo grande por la Files API ─────────────────────── */
async function subir(env, file) {
  const start = await fetch(`${API}/upload/v1beta/files?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(file.size),
      'X-Goog-Upload-Header-Content-Type': file.type || 'audio/mpeg',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: file.name || 'audio' } }),
  });
  const url = start.headers.get('x-goog-upload-url');
  if (!start.ok || !url) throw new Error(`Falló el inicio de subida (${start.status})`);

  const up = await fetch(url, {
    method: 'POST',
    headers: {
      'content-length': String(file.size),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: file.stream(),
  });
  if (!up.ok) throw new Error(`Falló la subida del audio (${up.status})`);
  let { file: f } = await up.json();

  // El archivo queda PROCESSING un rato; hay que esperar a ACTIVE.
  for (let i = 0; i < 30 && f.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const g = await fetch(`${API}/v1beta/${f.name}?key=${env.GEMINI_API_KEY}`);
    f = await g.json();
  }
  if (f.state !== 'ACTIVE') throw new Error(`El audio no quedó listo (${f.state})`);
  return { file_data: { mime_type: f.mimeType, file_uri: f.uri } };
}

async function inline(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { inline_data: { mime_type: file.type || 'application/octet-stream', data: btoa(bin) } };
}

/* ── 4. El prompt ────────────────────────────────────────────────────── */
function prompt({ nombre, edad, notas, fotos, ejemplos }) {
  return `Eres el asistente de Naran Estudio Dental. Recibes la grabación completa de la primera consulta (uno o más audios en orden) y las fotos clínicas del paciente.

PACIENTE: ${nombre || '(sin nombre)'}${edad ? `, ${edad} años` : ''}.
${notas ? `NOTAS DEL DENTISTA: ${notas}\n` : ''}
ARCHIVOS DE FOTO, en este orden: ${fotos.map((f, i) => `[${i}] ${f}`).join(', ') || '(ninguna)'}.

Devuelve EXCLUSIVAMENTE un JSON con esta forma:

{
  "transcripcion": [{"t":"mm:ss","audio":1,"quien":"Dra.|Paciente|Otro","texto":"..."}],
  "dsd": {
    "motivo_consulta":"", "lo_que_buscas":"", "lo_importante_para_ti":"", "expectativas":"", "frase_sintesis":""
  },
  "evidencia": [{"campo":"motivo_consulta","cita":"palabras textuales del paciente","audio":1,"t":"mm:ss"}],
  "perfil_disc": {
    "perfil":"", "nombre_perfil":"", "justificacion":"",
    "que_no_hacer":[""], "que_venderle":[""], "ampliacion":"", "pregunta_cierre":"", "ruta":[""]
  },
  "menciones_clinicas": [""],
  "plan_clinico": {
    "fase_salud":[""], "condicionales":[""], "contexto":"", "situacion_actual":[""], "plan_principal":[""],
    "objetivo":"", "alternativa_condicion":"", "alternativa_tratamiento":[""], "alternativa_mejora":[""],
    "alternativa_por_que_no_primero":""
  },
  "propuesta_fases": {
    "p1":[""], "p2":[""], "p2_alternativas":[""], "p3":[""], "p3_alternativas":[""],
    "como_explicarselo":"", "cuando_mostrar_p3":""
  },
  "fotos": [{"indice":0,"categoria":"retrato_serio","lado":null,"vista":null,"confianza":0.0}]
}

REGLAS, en orden de importancia:

1. NO DIAGNOSTICAS. "menciones_clinicas", "plan_clinico" y "propuesta_fases" se construyen ÚNICAMENTE con lo que el DENTISTA dijo en voz alta. Si el dentista no lo dijo, el campo va vacío. Nunca infieras un hallazgo, un tratamiento ni una pieza a partir de lo que dice el paciente o de las fotos.
2. Los textos de "dsd" van en SEGUNDA PERSONA dirigidos al paciente ("Quieres…", "Buscas…"), cálidos, sin tecnicismos, 2 a 3 líneas cada uno. "frase_sintesis" es una sola frase.
3. "evidencia" cita PALABRAS TEXTUALES del paciente, nunca parafraseadas, con el minuto en que las dijo.
4. Si algo no aparece en el audio, deja el campo vacío ("" o []). No rellenes con supuestos.
5. "condicionales" usa el formato "PIEZA · hallazgo → conducta" (ej. "1.4 · sospecha de caries distal → pedir bitewing").
6. Piezas siempre en notación FDI (1.1, 2.3…).
7. "fotos": clasifica cada archivo por su índice. "categoria" ∈ retrato_serio | retrato_sonriendo | perfil | sonrisa_frontal | sonrisa_lateral | escaneo | mapa_oclusal | rx_panoramica | rx_periapical | otro. "lado" ∈ izquierdo | derecho | null (desde la perspectiva del paciente). "vista" ∈ frontal | superior | inferior | lateral | null. "confianza" entre 0 y 1; si dudas, ponla bajo 0.6.
8. Español de Chile. No inventes nombres propios.
${ejemplos && ejemplos.length ? `\nCORRECCIONES PREVIAS DE ESTA CLÍNICA (imita este estilo y no repitas estos errores):\n${ejemplos.map((e) => `· ${e.campo}: la IA escribió "${e.valor_ia}" y quedó como "${e.valor_final}"`).join('\n')}` : ''}`;
}

/* ── 5. Handler ──────────────────────────────────────────────────────── */
export async function onRequestPost({ request, env }) {
  try {
    if (!env.GEMINI_API_KEY) return json({ error: 'Falta configurar GEMINI_API_KEY' }, 500);

    const u = await usuario(request, env);
    if (!u) return json({ error: 'Necesitas iniciar sesión' }, 401);

    const form = await request.formData();
    const audios = form.getAll('audio').filter((f) => f && typeof f === 'object');
    const fotos = form.getAll('foto').filter((f) => f && typeof f === 'object');
    if (!audios.length) return json({ error: 'Sube al menos un audio de la consulta' }, 400);

    const meta = {
      nombre: form.get('nombre') || '',
      edad: form.get('edad') || '',
      notas: form.get('notas') || '',
      fotos: fotos.map((f) => f.name),
      ejemplos: JSON.parse(form.get('ejemplos') || '[]'),
    };

    const partes = [{ text: prompt(meta) }];
    for (const a of audios) partes.push(a.size > MAX_INLINE ? await subir(env, a) : await inline(a));
    for (const f of fotos) partes.push(await inline(f));

    const model = await modelo(env);
    const r = await fetch(`${API}/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: partes }],
        generationConfig: { temperature: 0.3, responseMimeType: 'application/json' },
        safetySettings: [
          'HARM_CATEGORY_HARASSMENT',
          'HARM_CATEGORY_HATE_SPEECH',
          'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          'HARM_CATEGORY_DANGEROUS_CONTENT',
        ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      const msg = (data.error && data.error.message) || `Gemini respondió ${r.status}`;
      const cuota = r.status === 429;
      return json({ error: cuota ? 'Se acabó la cuota diaria de Gemini. Vuelve a intentar mañana.' : msg, cuota }, r.status);
    }

    const texto = (((data.candidates || [])[0] || {}).content || {}).parts?.[0]?.text || '';
    let caso;
    try {
      caso = JSON.parse(texto);
    } catch {
      return json({ error: 'Gemini no devolvió un JSON válido', crudo: texto.slice(0, 2000) }, 502);
    }
    return json({ ok: true, modelo: model, caso });
  } catch (e) {
    return json({ error: e.message || String(e) }, 500);
  }
}

export const onRequestGet = () => json({ error: 'Usa POST' }, 405);
