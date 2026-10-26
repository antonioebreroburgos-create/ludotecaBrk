'use strict';
/**
 * TARJETA DE VISITA DIGITAL del comercial (visita.html?e=DJI&c=…)
 *
 * Una página por comercial, para dar en mano (QR de la tarjeta impresa),
 * por WhatsApp o en la firma: su foto y teléfono, WhatsApp directo con él,
 * guardar el contacto en la agenda, el WhatsApp de pedidos (Copiloto),
 * la web, la dirección de la empresa y —en DJI— la cocina de demostraciones.
 *
 * El código "c" sale del teléfono del comercial firmado con la clave del
 * servidor: no hace falta tabla nueva y no se puede adivinar el de otro.
 * Variables opcionales en Netlify: WEB_DJI, WEB_SYL, EMAIL_DJI, EMAIL_SYL,
 * INSTAGRAM_DJI, INSTAGRAM_SYL (si no están, ese enlace no sale).
 */
const crypto = require('crypto');
const { supabase } = require('./supabaseClient');
const PC = require('./primerContacto');

const digitos9 = (t) => String(t || '').replace(/\D/g, '').slice(-9);

function codigoComercial(empresa, telefono) {
  const clave = process.env.TARJETA_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || 'copiloto';
  return crypto.createHmac('sha256', clave).update(`${empresa}:${digitos9(telefono)}`).digest('base64url').slice(0, 12);
}

function urlTarjetaVisita(empresa, telefono) {
  // Ruta "bonita" con vista previa en WhatsApp (ver visita-pagina.js y netlify.toml)
  return `${process.env.SITE_URL}/tarjeta/${empresa}/${codigoComercial(empresa, telefono)}`;
}

async function comercialPorCodigo(empresa, codigo) {
  if (!PC.EMPRESAS[empresa] || !codigo) return null;
  const { data } = await supabase.from('comerciales').select('*').eq('empresa', empresa).eq('activo', true);
  return (data || []).find((c) => c.telefono && codigoComercial(empresa, c.telefono) === codigo) || null;
}

function numeroCopiloto(empresa) {
  const n = empresa === 'SYL' ? process.env.TWILIO_WHATSAPP_NUMBER_SYL : process.env.TWILIO_WHATSAPP_NUMBER;
  return String(n || '').replace(/^whatsapp:/, '').replace(/\D/g, '') || null;
}

async function datosTarjeta(empresa, codigo) {
  const c = await comercialPorCodigo(empresa, codigo);
  if (!c) return null;
  const emp = PC.EMPRESAS[empresa];
  const tel = PC.normalizarTelefono(c.telefono);
  return {
    empresa,
    empresa_nombre: emp.nombre,
    color: emp.color, oscuro: emp.oscuro,
    direccion: emp.direccion,
    maps: emp.maps || (emp.cocina && emp.cocina.maps) || null,
    cocina: emp.cocina || null,
    web: emp.web, instagram: emp.instagram,
    copiloto: numeroCopiloto(empresa),
    razones: PC.RAZONES[empresa] || [],
    // Lo que sale en la tarjeta: columnas nombre_tarjeta, cargo y email de la tabla comerciales
    nombre: c.nombre_tarjeta || c.nombre || '',
    nombre_pila: PC.nombrePila(c.nombre_tarjeta || c.nombre),
    cargo: c.cargo || 'Comercial',
    telefono: tel,
    email: c.email || null,           // solo el correo del comercial, nunca el general
    foto: c.foto_url || null,
  };
}

module.exports = { codigoComercial, urlTarjetaVisita, comercialPorCodigo, datosTarjeta };
