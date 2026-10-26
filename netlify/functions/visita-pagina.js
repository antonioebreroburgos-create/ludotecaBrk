/**
 * TARJETA DE VISITA con vista previa en WhatsApp.
 * GET /tarjeta/<DJI|SYL>/<código>  (redirección en netlify.toml)
 *
 * WhatsApp no ejecuta JavaScript al crear la vista previa de un enlace:
 * lee las etiquetas Open Graph del HTML. Esta función devuelve la misma
 * página de la tarjeta (public/visita.html) con esas etiquetas ya puestas:
 * foto del comercial, "Nombre · Empresa" y "Cargo · teléfono".
 */
const { datosTarjeta } = require('./lib/tarjetaVisita');

const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const telBonito = (t) => String(t || '').replace(/^\+34/, '').replace(/\D/g, '').replace(/(\d{3})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4');

let plantilla = null; let plantillaAt = 0;
async function leerPlantilla() {
  if (plantilla && Date.now() - plantillaAt < 10 * 60000) return plantilla;
  const r = await fetch(`${process.env.SITE_URL}/visita.html`);
  if (!r.ok) throw new Error(`No se pudo leer visita.html (${r.status})`);
  plantilla = await r.text(); plantillaAt = Date.now();
  return plantilla;
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const empresa = String(q.e || '').toUpperCase();
  const codigo = String(q.c || '');
  try {
    const [html, d] = await Promise.all([leerPlantilla(), datosTarjeta(empresa, codigo).catch(() => null)]);
    if (!d) return { statusCode: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: html };
    const url = `${process.env.SITE_URL}/tarjeta/${empresa}/${codigo}`;
    const titulo = `${d.nombre} · ${d.empresa_nombre}`;
    const desc = `${d.cargo} · ${telBonito(d.telefono)}${d.email ? ' · ' + d.email : ''}. Escríbeme por WhatsApp, guarda mi contacto o haz tu pedido.`;
    const meta = [
      `<title>${esc(titulo)}</title>`,
      `<meta property="og:type" content="profile">`,
      `<meta property="og:site_name" content="${esc(d.empresa_nombre)}">`,
      `<meta property="og:title" content="${esc(titulo)}">`,
      `<meta property="og:description" content="${esc(desc)}">`,
      `<meta property="og:url" content="${esc(url)}">`,
      d.foto ? `<meta property="og:image" content="${esc(d.foto)}">` : '',
      `<meta name="description" content="${esc(desc)}">`,
      `<meta name="twitter:card" content="summary">`,
    ].filter(Boolean).join('\n');
    const salida = html.replace(/<title>[\s\S]*?<\/title>/i, meta);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
      body: salida,
    };
  } catch (err) {
    console.error('Error en visita-pagina:', err);
    return { statusCode: 302, headers: { Location: `/visita.html?e=${encodeURIComponent(empresa)}&c=${encodeURIComponent(codigo)}` }, body: '' };
  }
};
