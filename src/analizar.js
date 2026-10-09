/**
 * POST /api/analizar
 *
 * Recibe los audios y las fotos de una consulta, los manda a Gemini y
 * devuelve el JSON estructurado del caso.
 *
 * La API key de Gemini vive SOLO aquí (secreto de Cloudflare). El navegador
 * nunca la ve. Antes de gastar cuota, se verifica que quien llama tenga
 * sesión iniciada en Supabase.
 *
 * Variables de entorno (Cloudflare → Settings → Variables and Secrets):
 *   GEMINI_API_KEY   (secreto)   clave de Google AI Studio
 *   SUPABASE_URL     (texto)     https://xxxx.supabase.co
 *   SUPABASE_ANON_KEY(texto)     anon/publishable key
 *   CLAVE_PRUEBA     (secreto)   clave compartida mientras no haya Supabase
 *   GEMINI_MODEL     (opcional)  p. ej. gemini-flash-latest
 */

const API = 'https://generativelanguage.googleapis.com';
// Un audio incrustado hay que pasarlo a base64 dentro del Worker, y eso es
// cálculo puro: con decenas de MB se come el presupuesto de CPU y tarda.
// Por encima de este tamaño se sube en streaming por la Files API, que no
// consume CPU porque solo reenvía bytes.
const MAX_INLINE = 4 * 1024 * 1024;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/* ── 1. ¿Quién llama? ──────────────────────────────────────────────────
 * Con Supabase configurado, manda la sesión del usuario.
 * Mientras no lo esté (fase de pruebas), basta una clave compartida que se
 * carga como secreto CLAVE_PRUEBA. Sin ninguna de las dos, no se atiende:
 * así nadie que encuentre la URL puede gastar la cuota de Gemini.
 */
async function autorizado(request, env) {
  if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    const auth = request.headers.get('authorization') || '';
    if (!auth.toLowerCase().startsWith('bearer ')) return { ok: false, motivo: 'Necesitas iniciar sesión' };
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { authorization: auth, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!r.ok) return { ok: false, motivo: 'Tu sesión expiró; vuelve a entrar' };
    const u = await r.json();
    return u && u.id ? { ok: true, uid: u.id } : { ok: false, motivo: 'Sesión inválida' };
  }

  if (env.CLAVE_PRUEBA) {
    const dada = request.headers.get('x-clave') || '';
    // comparación de tiempo constante, para no filtrar la clave por latencia
    const a = new TextEncoder().encode(dada), b = new TextEncoder().encode(env.CLAVE_PRUEBA);
    let dif = a.length ^ b.length;
    for (let i = 0; i < Math.max(a.length, b.length); i++) dif |= (a[i] || 0) ^ (b[i] || 0);
    return dif === 0 ? { ok: true, uid: 'clave-prueba' } : { ok: false, motivo: 'Clave incorrecta' };
  }

  return { ok: false, motivo: 'Falta configurar el acceso: carga el secreto CLAVE_PRUEBA (o conecta Supabase) en Cloudflare' };
}

/* ── 2. Elegir modelos, por orden de preferencia ──────────────────────
 * Los alias "-latest" y los "preview" apuntan a lo más nuevo y son los que
 * más se saturan (503). Preferimos versiones estables y guardamos una lista
 * de repuesto para cambiar de modelo si el primero está caído.
 */
async function candidatos(env) {
  if (env.GEMINI_MODEL) return [env.GEMINI_MODEL];
  const r = await fetch(`${API}/v1beta/models?key=${env.GEMINI_API_KEY}&pageSize=200`);
  if (!r.ok) throw new Error(`No se pudo listar modelos (${r.status})`);
  const { models = [] } = await r.json();

  const nombres = models
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace(/^models\//, ''))
    // fuera lo que no sirve para esto: imagen, voz, música, investigación
    .filter((n) => /flash/i.test(n) && !/(image|tts|audio|lyria|nano|embedding|deep-research)/i.test(n));

  const version = (n) => parseFloat((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
  const puntaje = (n) =>
    (/(preview|exp)/i.test(n) ? 0 : 40) +   // estable antes que preview
    (/latest/i.test(n) ? 5 : 15) +          // versión fija antes que alias
    (/lite/i.test(n) ? 0 : 10) +            // lite solo como repuesto
    version(n);

  const orden = nombres.sort((a, b) => puntaje(b) - puntaje(a));
  if (!orden.length) throw new Error('Ningún modelo Flash disponible para esta clave');
  return orden.slice(0, 4);
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/* Llama a un modelo reintentando si está saturado; si no hay caso, pasa al siguiente. */
async function generar(env, modelos, cuerpo) {
  let ultimo = { status: 0, msg: 'sin intentos' };
  for (const model of modelos) {
    for (let intento = 0; intento < 2; intento++) {
      const r = await fetch(`${API}/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(cuerpo),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok) return { data, model };

      const msg = (data.error && data.error.message) || `Gemini respondió ${r.status}`;
      ultimo = { status: r.status, msg };
      console.log('[analizar]', model, r.status, msg.slice(0, 160));

      if (r.status === 503 || /overload|high demand/i.test(msg)) {
        if (intento === 0) { await esperar(2500); continue; }  // un respiro y reintenta
        break;                                                  // sigue saturado: cambia de modelo
      }
      if (r.status === 429) return { error: ultimo };            // cuota: cambiar de modelo no ayuda
      break;                                                     // otro error: no insistir
    }
  }
  return { error: ultimo };
}

/* Abre una sesión de subida y devuelve la URL. El navegador sube los bytes
 * directo a Google con esa URL, sin pasarlos por este Worker: el audio viaja
 * una vez en lugar de dos. La API key no sale de aquí. */
export async function urlDeSubida(request, env) {
  const quien = await autorizado(request, env);
  if (!quien.ok) return json({ error: quien.motivo }, 401);
  if (!env.GEMINI_API_KEY) return json({ error: 'Falta configurar GEMINI_API_KEY' }, 500);

  const { nombre, tamano, tipo } = await request.json().catch(() => ({}));
  if (!tamano || tamano > 500 * 1024 * 1024) return json({ error: 'Tamaño de archivo no válido' }, 400);

  const r = await fetch(`${API}/upload/v1beta/files?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(tamano),
      'X-Goog-Upload-Header-Content-Type': tipo || 'audio/mpeg',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: nombre || 'audio' } }),
  });
  const url = r.headers.get('x-goog-upload-url');
  if (!r.ok || !url) return json({ error: `No se pudo abrir la subida (${r.status})` }, 502);
  return json({ ok: true, url });
}

/* Espera a que un archivo ya subido quede listo para usarse. */
async function esperarActivo(env, nombreArchivo) {
  let f = { state: 'PROCESSING', name: nombreArchivo };
  for (let i = 0; i < 40 && f.state === 'PROCESSING'; i++) {
    const g = await fetch(`${API}/v1beta/${nombreArchivo}?key=${env.GEMINI_API_KEY}`);
    f = await g.json();
    if (f.state === 'PROCESSING') await new Promise((r) => setTimeout(r, i < 6 ? 400 : 1200));
  }
  if (f.state !== 'ACTIVE') throw new Error(`El audio no quedó listo (${f.state || 'desconocido'})`);
  return { file_data: { mime_type: f.mimeType, file_uri: f.uri } };
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
  for (let i = 0; i < 40 && f.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, i < 6 ? 400 : 1200));
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
function prompt({ nombre, edad, notas, fotos, ejemplos, nAudios, completa, texto }) {
  return `Eres el asistente de Naran Estudio Dental. Recibes la grabación completa de la primera consulta (uno o más audios en orden) y las fotos clínicas del paciente.

PACIENTE: ${nombre || '(sin nombre)'}${edad ? `, ${edad} años` : ''}.
${texto ? `TRANSCRIPCIÓN DE LA CONSULTA (ya hecha, no hay audio que escuchar):
«««
${texto}
»»»
Trabaja con ese texto tal cual. No inventes nada que no esté ahí.` : ''}
${nAudios ? `GRABACIONES ADJUNTAS: ${nAudios}.` : ''} Son partes consecutivas de la MISMA consulta, en orden. Escúchalas TODAS y trátalas como una sola conversación continua: la transcripción debe cubrir de principio a fin, numerando en "audio" de 1 a ${nAudios} según de cuál provenga cada línea. No te detengas al terminar la primera.
${notas ? `NOTAS DEL DENTISTA: ${notas}\n` : ''}
ARCHIVOS DE FOTO, en este orden: ${fotos.map((f, i) => `[${i}] ${f}`).join(', ') || '(ninguna)'}.

Devuelve EXCLUSIVAMENTE un JSON con esta forma:

{
  "transcripcion": [{"t":"mm:ss","audio":1,"quien":"Dra.|Paciente|Otro","texto":"..."}],   // ${completa ? 'palabra por palabra, de principio a fin' : 'SOLO los 12 a 20 momentos que importan, no la conversación entera'}
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
9. ${completa
  ? 'La transcripción va completa, palabra por palabra.'
  : 'NO transcribas la conversación entera: en "transcripcion" deja solo entre 12 y 20 intervenciones, las que realmente sostienen el caso (motivo, expectativas, objeciones, hallazgos del dentista, cierre). Es lo más importante de esta instrucción: una transcripción larga hace esperar al dentista sin aportarle nada que no esté ya en "evidencia".'}
${ejemplos && ejemplos.length ? `\nCORRECCIONES PREVIAS DE ESTA CLÍNICA (imita este estilo y no repitas estos errores):\n${ejemplos.map((e) => `· ${e.campo}: la IA escribió "${e.valor_ia}" y quedó como "${e.valor_final}"`).join('\n')}` : ''}`;
}

/* ── 5. Handler ──────────────────────────────────────────────────────── */
export async function analizar(request, env) {
  try {
    if (!env.GEMINI_API_KEY) return json({ error: 'Falta configurar GEMINI_API_KEY' }, 500);

    const quien = await autorizado(request, env);
    if (!quien.ok) return json({ error: quien.motivo }, 401);

    const form = await request.formData();
    const audios = form.getAll('audio').filter((f) => f && typeof f === 'object');
    // Los que el navegador ya subió directo a Google llegan como nombre de archivo.
    const yaSubidos = form.getAll('audio_subido').filter((x) => typeof x === 'string' && x);
    const fotos = form.getAll('foto').filter((f) => f && typeof f === 'object');
    const textoConsulta = (form.get('texto_consulta') || '').trim();
    if (!audios.length && !yaSubidos.length && !textoConsulta)
      return json({ error: 'Sube el audio de la consulta o su transcripción' }, 400);

    const meta = {
      nombre: form.get('nombre') || '',
      edad: form.get('edad') || '',
      notas: form.get('notas') || '',
      fotos: fotos.map((f) => f.name),
      ejemplos: JSON.parse(form.get('ejemplos') || '[]'),
      nAudios: audios.length + yaSubidos.length,
      completa: form.get('transcripcion') === 'completa',
      texto: (form.get('texto_consulta') || '').trim(),
    };

    const t0 = Date.now();
    // Los audios son lo pesado: van en paralelo, no uno después del otro.
    const [partesSubidas, partesAudio, partesFoto] = await Promise.all([
      Promise.all(yaSubidos.map((nombre) => esperarActivo(env, nombre))),
      Promise.all(audios.map((a) => (a.size > MAX_INLINE ? subir(env, a) : inline(a)))),
      Promise.all(fotos.map((f) => inline(f))),
    ]);
    const tSubida = Date.now() - t0;
    const partes = [{ text: prompt(meta) }, ...partesSubidas, ...partesAudio, ...partesFoto];
    console.log(
      `[analizar] ${textoConsulta ? `transcripción de ${textoConsulta.length} caracteres · ` : ''}` +
        `${audios.length + yaSubidos.length} audio(s) (${yaSubidos.length} subidos por el navegador) ` +
        `${Math.round(audios.reduce((s2, a) => s2 + a.size, 0) / 1048576)}MB + ` +
        `${fotos.length} foto(s) · preparado en ${(tSubida / 1000).toFixed(1)}s`,
    );

    const modelos = await candidatos(env);
    const cuerpo = {
        contents: [{ role: 'user', parts: partes }],
        generationConfig: {
          temperature: 0.3,
          responseMimeType: 'application/json',
          maxOutputTokens: 65536, // la transcripción de 40 min es larga: sin esto se corta a media frase
        },
        safetySettings: [
          'HARM_CATEGORY_HARASSMENT',
          'HARM_CATEGORY_HATE_SPEECH',
          'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          'HARM_CATEGORY_DANGEROUS_CONTENT',
        ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };

    const t1 = Date.now();
    const res = await generar(env, modelos, cuerpo);
    console.log(`[analizar] Gemini respondió en ${((Date.now() - t1) / 1000).toFixed(1)}s`);
    if (res.error) {
      const { status, msg } = res.error;
      const texto =
        status === 429
          ? 'Se acabó la cuota diaria de Gemini. Vuelve a intentar mañana.'
          : status === 503 || /overload|high demand/i.test(msg)
            ? `Los modelos de Gemini están saturados ahora mismo (probé ${modelos.length}). Espera unos minutos y vuelve a intentar; el audio y las fotos siguen cargados.`
            : msg;
      return json({ error: texto, cuota: status === 429 }, status || 502);
    }
    const { data, model } = res;

    const cand = (data.candidates || [])[0] || {};
    // Los modelos con razonamiento devuelven varias partes (incluidos "pensamientos"):
    // hay que juntar todas las que traigan texto, no solo la primera.
    const texto = ((cand.content || {}).parts || [])
      .filter((p) => typeof p.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();

    if (!texto) {
      const motivo =
        cand.finishReason === 'MAX_TOKENS'
          ? 'La respuesta se cortó por largo. Prueba con un audio más corto.'
          : cand.finishReason === 'SAFETY' || (data.promptFeedback || {}).blockReason
            ? 'Gemini bloqueó el contenido por sus filtros de seguridad.'
            : `Gemini respondió sin texto (${cand.finishReason || 'sin motivo'}).`;
      console.log('[analizar] sin texto', JSON.stringify({ finishReason: cand.finishReason, promptFeedback: data.promptFeedback }));
      return json({ error: motivo }, 502);
    }

    let caso;
    try {
      // por si viniera envuelto en ```json … ```
      caso = JSON.parse(texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
    } catch (e) {
      console.log('[analizar] JSON inválido', texto.slice(0, 500));
      return json({ error: 'Gemini no devolvió un JSON válido', detalle: texto.slice(0, 300) }, 502);
    }
    return json({ ok: true, modelo: model, caso, segundos: Math.round((Date.now() - t0) / 100) / 10 });
  } catch (e) {
    console.log('[analizar] excepción', e && (e.stack || e.message || String(e)));
    return json({ error: e.message || String(e) }, 500);
  }
}
