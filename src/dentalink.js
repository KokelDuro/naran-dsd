/**
 * Naran DSD · Dentalink
 *
 * La página nunca habla con Dentalink: habla con este Worker, y el Worker
 * guarda el token. Así el token no viaja al navegador y cada consulta pasa
 * antes por la sesión del usuario.
 *
 * Todo lo de aquí es de LECTURA. Crear o modificar presupuestos es otra
 * conversación y necesita, además, permisos de escritura en el token.
 */
import { autorizado } from './analizar.js';

const BASE = 'https://api.dentalink.healthatom.com/api';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

/* ── Llamada cruda a la API ───────────────────────────────────────────
 * Devuelve siempre {ok, data|error} para que arriba no haya que adivinar
 * si lo que llegó fue una respuesta o una excusa.
 */
async function pedir(env, ruta, { q, version = 'v1' } = {}) {
  if (!env.DENTALINK_TOKEN) {
    return { ok: false, estado: 503, error: 'Falta el token de Dentalink en el Worker' };
  }
  let url = `${BASE}/${version}${ruta}`;
  if (q) url += `?q=${encodeURIComponent(JSON.stringify(q))}`;

  let r;
  try {
    r = await fetch(url, { headers: { authorization: `Token ${env.DENTALINK_TOKEN}` } });
  } catch (e) {
    return { ok: false, estado: 502, error: `No se pudo llegar a Dentalink: ${e.message}` };
  }

  const texto = await r.text();
  let cuerpo = null;
  try { cuerpo = JSON.parse(texto); } catch { /* Dentalink devolvió algo que no es JSON */ }

  if (!r.ok) {
    // Dentalink manda el error como objeto: {error:{code,message}}
    const e = cuerpo && cuerpo.error;
    const detalle = (e && typeof e === 'object' ? e.message : e) ||
                    (cuerpo && cuerpo.message) || texto.slice(0, 200) || 'sin detalle';
    const pista = r.status === 401 ? ' (revisa el token y sus permisos)' : '';
    return { ok: false, estado: r.status, error: `Dentalink respondió ${r.status}: ${detalle}${pista}` };
  }
  if (!cuerpo) return { ok: false, estado: 502, error: 'Dentalink devolvió algo que no es JSON' };
  return { ok: true, data: cuerpo.data, enlaces: cuerpo.links };
}

/* ── RUT: normalizar y comprobar el dígito verificador ────────────────
 * Un RUT mal copiado se detecta aquí y no se gasta una consulta.
 */
export function rutLimpio(valor) {
  const t = String(valor || '').toUpperCase().replace(/[^0-9K]/g, '');
  if (t.length < 2) return null;
  const cuerpo = t.slice(0, -1), dv = t.slice(-1);
  if (!/^\d+$/.test(cuerpo)) return null;

  let suma = 0, factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const esperado = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  if (dv !== esperado) return null;
  return `${cuerpo}-${dv}`;
}

/* ── Buscar al paciente ───────────────────────────────────────────────
 * Por RUT si lo hay (es exacto); si no, por nombre, que puede traer varios.
 */
async function buscarPaciente(env, { rut, nombre }) {
  const limpio = rutLimpio(rut);

  if (limpio) {
    // El RUT identifica sin ambigüedad, así que se agota por ahí antes de
    // mirar el nombre. Cada ficha puede tenerlo escrito distinto —con
    // puntos, sin guion—, así que se prueban las formas habituales y, de
    // última, un «empieza por» sobre el cuerpo sin dígito verificador.
    const cuerpo = limpio.split('-')[0];
    const conPuntos = Number(cuerpo).toLocaleString('es-CL') + '-' + limpio.split('-')[1];
    const intentos = [
      { rut: { eq: limpio } },
      { rut: { eq: conPuntos } },
      { rut: { eq: cuerpo + limpio.split('-')[1] } },
      { rut: { lk: cuerpo } },
    ];
    for (const q of intentos) {
      const r = await pedir(env, '/pacientes', q);
      if (!r.ok) return r;
      const lista = (Array.isArray(r.data) ? r.data : [])
        .filter((p) => rutLimpio(p.rut) === limpio);
      if (lista.length) return { ok: true, data: lista, por: 'rut' };
    }
    return {
      ok: false,
      estado: 404,
      error: `El RUT ${limpio} no está en Dentalink. Revísalo en el paso 1, o busca sin RUT para ir por nombre.`,
    };
  }

  const texto = String(nombre || '').trim();
  if (!texto) {
    return { ok: false, estado: 400, error: 'Escribe el RUT del paciente en el paso 1' };
  }
  // el nombre de pila basta: los apellidos suelen venir en otra columna
  const primera = texto.split(/\s+/)[0];
  const r = await pedir(env, '/pacientes', { nombre: { lk: primera } });
  if (!r.ok) return r;

  const lista = (Array.isArray(r.data) ? r.data : []).filter((p) => parecido(p, texto));
  return { ok: true, data: lista, por: 'nombre' };
}

/* Compara el nombre dictado con el de Dentalink sin exigir que calce entero:
   basta que todas las palabras del más corto estén en el más largo. */
function parecido(paciente, buscado) {
  const norm = (s) =>
    String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const suyo = norm(`${paciente.nombre || ''} ${paciente.apellidos || ''}`);
  const partes = norm(buscado).split(/\s+/).filter((w) => w.length > 2);
  if (!partes.length) return true;
  return partes.every((w) => suyo.includes(w));
}

/* ── Armar el presupuesto ─────────────────────────────────────────────
 * Dos llamadas que se cruzan: el desglose trae las secciones y los totales
 * del documento; el detalle trae prestación por prestación. Juntas dan la
 * misma tabla que hoy sale de leer el PDF.
 */
async function presupuesto(env, idTratamiento) {
  const [desglose, detalles] = await Promise.all([
    pedir(env, `/tratamientos/${idTratamiento}/desgloce-por-seccion`),
    pedir(env, `/tratamientos/${idTratamiento}/detalles`),
  ]);
  if (!detalles.ok) return detalles;

  const secciones = (desglose.ok && desglose.data && desglose.data.secciones) || [];
  // de qué sección viene cada prestación, para proponerla como fase
  const seccionDe = {};
  secciones.forEach((s) => {
    (s.prestaciones || []).forEach((p) => {
      const id = p.id_detalle_tratamiento ?? p.id_detalle_presupuesto;
      if (id != null) seccionDe[id] = (s.nombre_seccion || '').trim();
    });
  });

  const prestaciones = (Array.isArray(detalles.data) ? detalles.data : []).map((d) => {
    const piezas = (d.pieza || []).map((p) => p.numero).filter(Boolean);
    return {
      id: d.id,
      nombre: d.nombre_prestacion || '',
      pieza: piezas.join(', ') || '—',
      precio: num(d.precio),
      descuento: num(d.descuento_total),
      total: num(d.total),
      pagado: num(d.pagado),
      realizada: !!d.realizado,
      estado: d.realizado ? 'Realizada' : 'Pendiente',
      seccion: seccionDe[d.id] || '',
    };
  });

  const g = desglose.ok && desglose.data ? desglose.data : {};
  return {
    ok: true,
    data: {
      prestaciones,
      secciones: secciones.map((s) => ({
        nombre: (s.nombre_seccion || '').trim(),
        total: num(s.total_seccion),
        abonado: num(s.abonado_seccion),
        deuda: num(s.deuda_seccion),
      })).filter((s) => s.nombre),
      resumen: {
        total: num(g.total),
        abonado: num(g.abonado),
        deuda: num(g.deuda),
        realizado: num(g.total_realizado),
      },
      /* si el desglose falló, la tabla igual sirve: solo faltan las fases */
      aviso: desglose.ok ? null : desglose.error,
    },
  };
}

const num = (v) => (v == null || v === '' ? 0 : Math.round(Number(v) || 0));

/* ── Rutas ────────────────────────────────────────────────────────────── */
export async function dentalink(request, env, pathname) {
  const permiso = await autorizado(request, env);
  if (!permiso.ok) return json({ error: permiso.motivo }, 401);
  if (!env.DENTALINK_TOKEN) return json({ error: 'Dentalink no está conectado todavía', sinToken: true }, 503);

  const url = new URL(request.url);
  const resto = pathname.replace('/api/dentalink', '') || '/';

  /* Diagnóstico: comprueba que el token sirve y muestra qué llegó.
     Es lo primero que conviene mirar al conectar la clínica. */
  if (resto === '/prueba') {
    const r = await pedir(env, '/pacientes', { id: { gt: 0 } });
    return r.ok
      ? json({ ok: true, pacientes: Array.isArray(r.data) ? r.data.length : 0, muestra: (r.data || [])[0] || null })
      : json({ error: r.error }, r.estado);
  }

  if (resto === '/paciente') {
    const r = await buscarPaciente(env, {
      rut: url.searchParams.get('rut'),
      nombre: url.searchParams.get('nombre'),
    });
    if (!r.ok) return json({ error: r.error }, r.estado);
    return json({
      ok: true,
      por: r.por,
      pacientes: r.data.map((p) => ({
        id: p.id,
        nombre: `${p.nombre || ''} ${p.apellidos || ''}`.trim(),
        rut: p.rut || '',
        nacimiento: p.fecha_nacimiento || '',
      })),
    });
  }

  if (resto === '/tratamientos') {
    const id = url.searchParams.get('paciente');
    if (!id) return json({ error: 'Falta el paciente' }, 400);
    const r = await pedir(env, `/pacientes/${encodeURIComponent(id)}/tratamientos`);
    if (!r.ok) return json({ error: r.error }, r.estado);
    const lista = (Array.isArray(r.data) ? r.data : []).map((t) => ({
      id: t.id,
      nombre: t.nombre || 'Plan de tratamiento',
      fecha: t.fecha || '',
      total: num(t.total),
      deuda: num(t.deuda),
      finalizado: !!t.finalizado,
    }));
    // el más reciente primero: es casi siempre el que se está cotizando
    lista.sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    return json({ ok: true, tratamientos: lista });
  }

  if (resto === '/presupuesto') {
    const id = url.searchParams.get('tratamiento');
    if (!id) return json({ error: 'Falta el tratamiento' }, 400);
    const r = await presupuesto(env, encodeURIComponent(id));
    return r.ok ? json({ ok: true, ...r.data }) : json({ error: r.error }, r.estado);
  }

  return json({ error: 'No existe esa ruta' }, 404);
}
