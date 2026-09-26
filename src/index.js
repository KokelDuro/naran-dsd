/**
 * Naran DSD · Worker
 *
 * Los archivos estáticos de ./public los sirve Cloudflare directamente (binding
 * ASSETS). Lo que no calza con un archivo llega acá: solo /api/*.
 */
import { analizar } from './analizar.js';
import { salud } from './salud.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/salud') {
      return request.method === 'GET' ? salud(env) : json({ error: 'Usa GET' }, 405);
    }

    if (pathname === '/api/analizar') {
      return request.method === 'POST' ? analizar(request, env) : json({ error: 'Usa POST' }, 405);
    }

    if (pathname.startsWith('/api/')) return json({ error: 'No existe esa ruta' }, 404);

    // Cualquier otra cosa: la sirve el manejador de assets (o su 404).
    return env.ASSETS.fetch(request);
  },
};
