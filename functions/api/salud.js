/** GET /api/salud — dice qué está configurado, sin revelar ningún valor. */
export async function onRequestGet({ env }) {
  const estado = {
    gemini_key: !!env.GEMINI_API_KEY,
    supabase_url: !!env.SUPABASE_URL,
    supabase_anon: !!env.SUPABASE_ANON_KEY,
    modelo_fijado: env.GEMINI_MODEL || '(automático)',
  };
  let modelos = null;
  if (env.GEMINI_API_KEY) {
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}&pageSize=200`,
      );
      if (r.ok) {
        const { models = [] } = await r.json();
        modelos = models
          .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
          .map((m) => m.name.replace(/^models\//, ''))
          .filter((n) => /flash|pro/i.test(n))
          .slice(0, 40);
      } else {
        modelos = `error ${r.status}`;
      }
    } catch (e) {
      modelos = `error ${e.message}`;
    }
  }
  return new Response(JSON.stringify({ ok: true, estado, modelos }, null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
