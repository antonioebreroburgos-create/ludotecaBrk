const { supabase } = require('./supabaseClient');
const { buscarClientesComercial, getFacturasCliente, asignarVendedorPedido, resolverClienteComercial, getStockDisponible, getComprasPendientesProducto, getCosteYPrecioMedioVenta, anotarStockLineas, getMiDiaComercial, getFaltasComercial, getEmpresaActiva, searchRead, getFacturasClientePeriodo } = require('./odooClient');
const { subirPdfStorage } = require('./facturaPdf');
const { generarInformeFacturasPdf } = require('./informeFacturasPdf');
const { guardarFotoGaleria } = require('./galeria');
const { obtenerDirecciones, crearPresupuesto, buscarEnCatalogoCliente, guardarAliasCliente, guardarCantidadAprendida, actualizarCatalogoCliente } = require('./pedidoInterprete');
const { lineaDeudaSemaforo, generarAvisosCliente } = require('./avisosCliente');
const {
  prepararAvisoCliente, elegirContactoYProgramar, crearContactoYProgramar,
  cancelarUltimoAviso, intentarRelevarRespuestaCliente,
} = require('./avisoClienteFinal');
const { autorizarTelefono } = require('./clientesAutorizados');
const { generarEstudioCliente } = require('./estudioCliente');
const { generarConsumoCliente } = require('./consumoCliente');
const { crearEnlace360, DIAS_VALIDEZ: DIAS_INFORME_360 } = require('./informe360');
const { guardarFotoRecibida, crearTrabajo, guardarPedidoRecibido, asignarPedidosRecibidos } = require('./pedido360');
const {
  listarComercialesActivos, crearTarea, puntosPendientesDe, tareasCreadasPor,
  marcarPuntoHecho, quedanPuntosPendientes,
} = require('./tareas');
const { listarEnReparto, listarRepartidos, listarSinConfirmar, listarUltimosPedidos, detallePedido, resumenSemanal, resumenGlobalComercial, listarEntregadosSemanaComercial } = require('./seguimientoPedidos');
const { formatearResultadoPedido } = require('./pedidoFormato');
const { enviarMensajeLibre } = require('./twilioClient');
const { MENU_FEEDBACK, ESTADOS_FEEDBACK, manejarFeedback, iniciarReporte } = require('./feedback');
const { palabrasBusqueda, dominioOdooPalabras } = require('./busqueda');
const { respuestaFicha, enviarAdjunto, listarFichasProducto, tieneFicha, urlFicha, productosCliente, fichasDeProductos } = require('./fichaTecnica');
const {
  obtenerVentasTodosPeriodos, obtenerTopClientes, obtenerTopArticulos,
  obtenerMisObjetivos, obtenerPendientesCobro, obtenerClientesInactivos,
  formatearVentasTodosPeriodos, formatearTopClientes, formatearTopArticulos, formatearMiDia,
  formatearObjetivos, formatearPendientesCobro, formatearClientesInactivos, formatearFaltas,
  rangoActual,
} = require('./misDatos');

// La empresa activa (DJI o SYL) la decide odooClient.setEmpresaActiva(),
// llamado una vez al principio de cada mensaje (según el número de
// WhatsApp que lo recibió) — aquí solo se lee, nunca se fija a mano,
// para que un solo sitio controle la empresa en todo el sistema.

const PEDIDOS_URL = process.env.PEDIDOS_DJI_API_URL;
const PEDIDOS_KEY = process.env.PEDIDOS_DJI_API_KEY;
const SITE_URL = process.env.SITE_URL; // URL pública de este sitio, para construir el enlace del catálogo
const MAX_CANDIDATOS = 8; // no saturar el mensaje de WhatsApp con demasiadas opciones

async function getSesion(telefono) {
  const { data } = await supabase.from('sesiones_whatsapp').select('*').eq('telefono', telefono).maybeSingle();
  return data || { telefono, estado: 'menu', contexto: null };
}

async function guardarSesion(telefono, estado, contexto = null) {
  await supabase.from('sesiones_whatsapp').upsert({ telefono, estado, contexto }, { onConflict: 'telefono' });
}

const MENSAJE_MENU = `👋 ¿En qué puedo ayudarte?\n\n1️⃣ *STOCK* — consultar stock de un producto\n2️⃣ *CATALOGOS/GALERIA* — PDFs y fotos\n3️⃣ *CLIENTE* — facturas, estudio, pedido, seguimiento\n4️⃣ *MIS DATOS* — tus ventas, clientes, objetivos y más\n5️⃣ *ENLACES* — apps y paneles internos\n6️⃣ *TAREAS* — que no se te pase nada\n7️⃣ *MEJORAS Y ERRORES* — avisa de fallos o propón ideas\n8️⃣ *FICHA TÉCNICA* — el PDF del artículo\n\nResponde con el número o la palabra.\n\n⚡ _Atajos: *catalogo asiatico* · *stock hamburguesa angus* · *ficha hamburguesa angus* · *pedido gansa* · *web gansa* · *consumo gansa* · *prospectar el viso del alcor*_\n_¿Algo falla? Escribe *reportar*._`;

// Menú para usuarios de CONSULTA (sin cartera de clientes: almacén,
// oficina, dirección…). Mismos números que el menú completo, para que
// la guía y los atajos sirvan igual; solo faltan CLIENTE y MIS DATOS.
const MENSAJE_MENU_CONSULTA = `👋 ¿En qué puedo ayudarte?\n\n1️⃣ *STOCK* — consultar stock de un producto\n2️⃣ *CATALOGOS/GALERIA* — PDFs y fotos\n5️⃣ *ENLACES* — apps y paneles internos\n6️⃣ *TAREAS* — que no se te pase nada\n7️⃣ *MEJORAS Y ERRORES* — avisa de fallos o propón ideas\n8️⃣ *FICHA TÉCNICA* — el PDF del artículo\n\nResponde con el número o la palabra.\n\n⚡ _Atajos: *catalogo asiatico* · *stock hamburguesa angus* · *ficha hamburguesa angus*_\n_¿Algo falla? Escribe *reportar*._`;

const esConsulta = (comercial) => (comercial?.perfil || 'comercial') === 'consulta';

const MENU_MIS_DATOS = `📋 *Mis Datos*\n\n1️⃣ Mis ventas\n2️⃣ Mis clientes\n3️⃣ Mis artículos\n4️⃣ Mi día\n5️⃣ Mis objetivos\n6️⃣ Mis pendientes de cobro\n7️⃣ Clientes sin pedido reciente\n8️⃣ Mis faltas\n9️⃣ En reparto / sin confirmar (todos)\n🔟 Entregados esta semana (todos)\n\nResponde con el número, o escribe *menu* para volver al principio.`;

const MENU_TAREAS = `✅ *Tareas*\n\n1️⃣ Nueva tarea\n2️⃣ Mis tareas pendientes\n3️⃣ Tareas que he creado\n\nResponde con el número, o escribe *menu* para volver al principio.`;

// ------------------------------------------------------------
// STOCK — la búsqueda de producto reutiliza pedidos-dji (no cambia
// minuto a minuto), pero el stock y lo pendiente de recibir se
// consultan en vivo a Odoo, para que sea el dato real del momento.
// ------------------------------------------------------------
async function buscarProductos(query) {
  // Búsqueda por varias palabras directamente en Odoo, para DJI y SYL.
  // Si en DJI no sale nada, se prueba además el buscador de pedidos-dji
  // (que a veces encuentra por otros campos).
  const encontrados = await buscarProductosOdoo(query);
  if (encontrados.length > 0 || getEmpresaActiva() !== 'DJI') return encontrados;
  try {
    const res = await fetch(`${PEDIDOS_URL}/api/traza/buscar?q=${encodeURIComponent(query)}`, {
      headers: { 'x-api-key': PEDIDOS_KEY },
    });
    if (!res.ok) return [];
    const { ok, data } = await res.json();
    return ok ? data : []; // [{ id, nombre, ref }]
  } catch (err) {
    console.error('Buscador pedidos-dji no disponible:', err.message);
    return [];
  }
}

/**
 * Búsqueda de producto en Odoo (product.product) por VARIAS palabras:
 * "hamburguesa angus" devuelve los que contienen las dos, en cualquier
 * orden. Se pide uno más del máximo que se enseña para saber si hay más
 * resultados y sugerir afinar la búsqueda.
 */
async function buscarProductosOdoo(query) {
  const palabras = palabrasBusqueda(query);
  if (palabras.length === 0) return [];
  const productos = await searchRead(
    'product.product',
    [...dominioOdooPalabras(palabras), ['sale_ok', '=', true]],
    ['id', 'name', 'default_code'],
    { limit: MAX_CANDIDATOS + 1, order: 'name asc', context: { lang: 'es_ES' } }, // sin lang, Odoo puede devolver una traducción antigua del nombre
  );
  return productos.map((p) => ({ id: p.id, nombre: p.name, ref: p.default_code || null }));
}

async function consultarStock(productoId) {
  const [stockInfo, comprasPendientes, precios] = await Promise.all([
    getStockDisponible([productoId]),
    getComprasPendientesProducto(productoId),
    // Si falla la parte de precios, el stock se sigue mostrando igual
    getCosteYPrecioMedioVenta(productoId, MESES_PRECIO_MEDIO).catch((err) => {
      console.error('[Stock] Error calculando coste/precio medio (no bloquea):', err.message);
      return null;
    }),
  ]);
  return {
    stock_total: stockInfo[0]?.qty_available ?? 0,
    compras_pendientes: comprasPendientes,
    precios,
  };
}

const MESES_PRECIO_MEDIO = 6;

function euros(valor) {
  return `${(Math.round(valor * 100) / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

/**
 * Bloque de coste / precio medio / margen para la respuesta de STOCK.
 * Margen SOBRE VENTA: (precio medio - coste) / precio medio.
 * Marcado como uso interno: la respuesta de stock se suele reenviar y
 * el coste no debe llegarle nunca al cliente.
 */
// "Unidades" / "Unit(s)" de Odoo → "ud", para que se lea "9,80 € / ud"
function unidadCorta(nombre) {
  if (!nombre) return null;
  return /^(unid|unit)/i.test(nombre) ? 'ud' : nombre;
}

function formatearBloquePrecios(p) {
  if (!p) return '💶 No he podido calcular coste y precio medio ahora mismo.';
  p = { ...p, unidad: unidadCorta(p.unidad) };
  const unidad = p.unidad ? ` / ${p.unidad}` : '';
  const lineas = ['🔒 *Solo para ti — no reenviar al cliente*'];

  lineas.push(p.coste > 0 ? `Coste: ${euros(p.coste)}${unidad}` : 'Coste: sin informar en Odoo');

  if (p.precio_medio == null) {
    lineas.push(`Venta media: sin ventas en los últimos ${p.meses} meses`);
    return lineas.join('\n');
  }

  const cantidad = Math.round(p.cantidad_vendida * 100) / 100;
  lineas.push(`Venta media ${p.meses} meses: ${euros(p.precio_medio)}${unidad}`);
  lineas.push(`   (${p.num_lineas} ${p.num_lineas === 1 ? 'venta' : 'ventas'} · ${cantidad.toLocaleString('es-ES')}${p.unidad ? ` ${p.unidad}` : ''})`);

  if (p.coste > 0 && p.precio_medio > 0) {
    const margen = ((p.precio_medio - p.coste) / p.precio_medio) * 100;
    const txt = margen.toLocaleString('es-ES', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    lineas.push(margen < 0
      ? `⚠️ Margen sobre venta: ${txt}% (se está vendiendo por debajo de coste)`
      : `Margen sobre venta: ${txt}%`);
  }
  lineas.push('_Precios sin IVA_');
  return lineas.join('\n');
}

function formatearRespuestaStock(nombre, info, { ocultarPrecios = false } = {}) {
  const stock = Math.round((info.stock_total || 0) * 100) / 100;
  const pendientes = info.compras_pendientes || [];
  const totalPendiente = pendientes.reduce((s, c) => s + (c.cantidad_pendiente || 0), 0);

  let lineaPendiente;
  if (totalPendiente > 0) {
    const detalle = pendientes
      .map((c) => `   • ${c.pedido || '(sin referencia)'} — ${Math.round((c.cantidad_pendiente || 0) * 100) / 100} uds${c.proveedor ? ` (${c.proveedor})` : ''}`)
      .join('\n');
    lineaPendiente = `📥 Pendiente de recibir: ${Math.round(totalPendiente * 100) / 100} uds\n${detalle}`;
  } else {
    lineaPendiente = '✅ Sin compras pendientes de recibir.';
  }

  const bloquePrecios = ocultarPrecios ? '' : `\n\n${formatearBloquePrecios(info.precios)}`;
  return `📦 *${nombre}*\nStock actual: ${stock} uds\n${lineaPendiente}${bloquePrecios}`;
}

/**
 * Respuesta completa de STOCK para un producto ya elegido. Mira a la vez
 * si el artículo tiene ficha técnica en Odoo, para ofrecerla: tras ver
 * el stock basta con escribir "ficha".
 */
async function responderStock(telefono, producto, comercial) {
  const [traza, hayFicha] = await Promise.all([consultarStock(producto.id), tieneFicha(producto.id)]);
  // Se guarda lo necesario para "r" (mensaje para el cliente) y "ficha"
  await guardarSesion(telefono, 'menu', {
    ultimo_producto: {
      id: producto.id,
      nombre: producto.nombre,
      ref: producto.ref || null,
      stock: Math.round((traza.stock_total || 0) * 100) / 100,
      pendiente: (traza.compras_pendientes || []).reduce((s, c) => s + (c.cantidad_pendiente || 0), 0),
      precio_medio: traza.precios?.precio_medio ?? null,
      unidad: unidadCorta(traza.precios?.unidad) || 'ud',
      hay_ficha: hayFicha,
    },
  });
  const lineaFicha = hayFicha ? '\n\n📑 Escribe *ficha* y te mando la ficha técnica en PDF.' : '';
  const lineaR = '\n📤 Escribe *r* y te preparo un mensaje para el cliente (precio' + (hayFicha ? ' y ficha técnica' : '') + ').';
  return { texto: `${formatearRespuestaStock(producto.nombre, traza, { ocultarPrecios: esConsulta(comercial) })}${lineaFicha}${lineaR}\n\nEscribe *menu* para otra consulta.` };
}

// ------------------------------------------------------------
// "r" tras STOCK: mensaje listo para reenviar al cliente
// ------------------------------------------------------------

/** "11,90" / "11.9" / "11,90€" → 11.9 ; texto no numérico → null */
function leerPrecio(texto) {
  const limpio = String(texto || '').replace(/€|eur(os)?/gi, '').replace(/\s/g, '');
  if (!/^\d+([.,]\d{1,3})?$/.test(limpio)) return null;
  return parseFloat(limpio.replace(',', '.'));
}

function textoParaClienteStock(p, precio) {
  // Sin datos de stock: el cliente no debe ver cuánto tenemos de cada producto
  const cuerpo = [];
  if (precio != null) cuerpo.push(`💶 Precio: *${euros(precio)} / ${p.unidad}* + IVA`);
  if (p.hay_ficha) cuerpo.push('📑 Te adjunto la ficha técnica.');
  return [
    `Hola, te paso la información de *${p.nombre}*${p.ref ? ` (ref. ${p.ref})` : ''}${cuerpo.length ? ':' : '.'}`,
    ...(cuerpo.length ? ['', ...cuerpo] : []),
    '',
    'Cualquier duda, me dices.',
  ].join('\n');
}

/** Ficha técnica principal del producto (la que parece ficha, o la más reciente). null si no hay. */
async function urlFichaPrincipal(productoId) {
  const fichas = await listarFichasProducto(productoId);
  return fichas.length ? urlFicha(fichas[0]) : null;
}

// ------------------------------------------------------------
// FICHA TÉCNICA (PDF adjunto al artículo en Odoo) — ver fichaTecnica.js
// todas = true ("otros pdf" tras una ficha): enseña todos los PDF del artículo para elegir
// ------------------------------------------------------------
async function responderFicha(telefono, producto, todas = false) {
  let r;
  if (todas) {
    const fichas = await listarFichasProducto(producto.id);
    r = fichas.length > 1 ? { varios: fichas.slice(0, 8) } : await respuestaFicha(producto);
  } else {
    r = await respuestaFicha(producto);
  }
  if (r.varios) {
    await guardarSesion(telefono, 'esperando_adjunto_ficha', { producto, adjuntos: r.varios });
    const lista = r.varios.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
    return { texto: `📑 *${producto.nombre}* tiene varios PDF adjuntos en Odoo:\n\n${lista}\n\nResponde con el número.` };
  }
  await guardarSesion(telefono, 'menu', { ultimo_producto: producto });
  return r;
}

const MAX_FICHAS_UNA_A_UNA = 40;

function listaNombres(nombres, max = 10) {
  const vis = nombres.slice(0, max).map((n) => `• ${n}`).join('\n');
  return nombres.length > max ? `${vis}\n…y ${nombres.length - max} más` : vis;
}

/**
 * CLIENTE → 6: fichas técnicas de todos los productos que el cliente ha
 * comprado en los últimos 12 meses (no los de su tarifa: puede tener
 * artículos que hace años que no pide).
 * Aquí solo se cuenta y se pregunta cómo las quiere; el envío (lento)
 * lo hace enviar-fichas-cliente-background.
 */
async function prepararFichasCliente(telefono, clienteId, clienteNombre) {
  let productos;
  let conFicha;
  let sinFicha;
  try {
    ({ productos } = await productosCliente(clienteId));
    if (!productos.length) {
      return { texto: `📭 *${clienteNombre}* no ha comprado nada en los últimos 12 meses.\n\n${MENU_CLIENTE(clienteNombre)}` };
    }
    ({ conFicha, sinFicha } = await fichasDeProductos(productos));
  } catch (err) {
    console.error('Error preparando las fichas del cliente:', err);
    return { texto: `⚠️ No he podido consultar las fichas en Odoo ahora mismo. Inténtalo de nuevo en un momento.\n\n${MENU_CLIENTE(clienteNombre)}` };
  }

  const deDonde = `los ${productos.length} artículos que ha comprado en los últimos 12 meses`;
  const faltan = sinFicha.length
    ? `\n\n⚠️ Sin ficha en Odoo (${sinFicha.length}):\n${listaNombres(sinFicha)}`
    : '';

  if (!conFicha.length) {
    await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
    return { texto: `📑 He mirado ${deDonde} y ninguno tiene la ficha técnica adjunta en Odoo.\n\n${MENU_CLIENTE(clienteNombre)}` };
  }

  await guardarSesion(telefono, 'esperando_modo_fichas_cliente', { clienteId, clienteNombre, items: conFicha });
  const opcionUna = conFicha.length <= MAX_FICHAS_UNA_A_UNA
    ? '\n2️⃣ Una a una (un mensaje por ficha)'
    : '';
  return {
    texto: `📑 *Fichas técnicas — ${clienteNombre}*\nHe mirado ${deDonde}: *${conFicha.length}* tienen ficha.${faltan}\n\n¿Cómo las quieres?\n1️⃣ Un PDF con todas (con índice)${opcionUna}\n\nResponde con el número, o *menu* para salir.`,
  };
}

/** Busca el producto por texto y manda la ficha, o la lista para elegir. */
async function buscarYResponderFicha(telefono, textoProducto, todas = false) {
  if (textoProducto.length < 2) {
    return { texto: 'Escribe al menos 2 letras del nombre del producto.' };
  }
  const candidatos = await buscarProductos(textoProducto);
  if (candidatos.length === 0) {
    await guardarSesion(telefono, 'esperando_producto_ficha', { todas });
    return { texto: `No he encontrado ningún producto con "${textoProducto}". Prueba con otra palabra, o escribe *menu* para volver al principio.` };
  }
  if (candidatos.length === 1) return responderFicha(telefono, candidatos[0], todas);

  const lista = candidatos.slice(0, MAX_CANDIDATOS);
  const hayMas = candidatos.length > MAX_CANDIDATOS
    ? '\n\n🔎 Hay más resultados. Si no ves el tuyo, escribe *ficha* y una palabra más (ej. "ficha hamburguesa angus 180").'
    : '';
  await guardarSesion(telefono, 'esperando_seleccion_ficha', { candidatos: lista, todas });
  return { texto: `¿De qué producto quieres la ficha técnica?\n\n${lista.map((p, i) => `${i + 1}. ${p.nombre}${p.ref ? ` (${p.ref})` : ''}`).join('\n')}${hayMas}\n\nResponde con el número.` };
}

// ------------------------------------------------------------
// CATÁLOGOS
// ------------------------------------------------------------
async function listarCatalogos() {
  const { data } = await supabase
    .from('catalogos')
    .select('*')
    .eq('activo', true)
    .eq('empresa', getEmpresaActiva())
    .order('orden', { ascending: true });
  return data || [];
}

// ------------------------------------------------------------
// ENLACES ÚTILES (apps y paneles internos)
// ------------------------------------------------------------
async function listarEnlaces() {
  const { data } = await supabase
    .from('enlaces_utiles')
    .select('*')
    .eq('activo', true)
    .eq('empresa', getEmpresaActiva())
    .order('orden', { ascending: true });
  return data || [];
}

function formatearEnlaces(enlaces) {
  if (enlaces.length === 0) return '🔗 *Enlaces*\n\nNo hay enlaces configurados todavía.';
  const lista = enlaces.map((e) => {
    const desc = e.descripcion ? `\n   _${e.descripcion}_` : '';
    return `*${e.nombre}*${desc}\n${e.url}`;
  }).join('\n\n');
  return `🔗 *Enlaces*\n\n${lista}`;
}

function urlCatalogo(archivo) {
  // La carpeta en el repo es public/Catalogos (con C mayúscula) y Netlify
  // distingue mayúsculas de minúsculas en las rutas.
  return `${SITE_URL}/Catalogos/${encodeURIComponent(archivo)}`;
}

/**
 * Respuesta para un catálogo elegido. Si en la tabla "catalogos" tiene
 * relleno el campo "enlace" (Supabase Storage, Google Drive…), se manda
 * el enlace de descarga en vez del PDF adjunto: es para los catálogos
 * que pesan más de lo que admite WhatsApp (~16 MB).
 */
function respuestaCatalogo(catalogo, pie) {
  if (catalogo.enlace) {
    return {
      texto: `📄 Catálogo de *${catalogo.familia}* — pesa demasiado para WhatsApp, descárgalo aquí:\n${catalogo.enlace}\n\n_Puedes reenviarle este mensaje al cliente tal cual._\n\n${pie}`,
    };
  }
  return {
    texto: `📄 Aquí tienes el catálogo de *${catalogo.familia}*.\n\n${pie}`,
    mediaUrl: urlCatalogo(catalogo.archivo),
  };
}

// ------------------------------------------------------------
// ALIAS DE CLIENTE — atajo propio del comercial, ajeno a Odoo
// ------------------------------------------------------------
async function buscarAliasCliente(telefono, texto) {
  const { data } = await supabase
    .from('alias_clientes')
    .select('cliente_id, cliente_nombre, alias')
    .eq('telefono', telefono)
    .ilike('alias', `%${texto}%`)
    .limit(5);
  return data || [];
}

async function guardarAliasComercial(telefono, alias, clienteId, clienteNombre) {
  const { error } = await supabase
    .from('alias_clientes')
    .upsert({ telefono, alias, cliente_id: clienteId, cliente_nombre: clienteNombre }, { onConflict: 'telefono,alias' });
  if (error) throw error;
}

// ------------------------------------------------------------
// FACTURAS
// ------------------------------------------------------------
function soloDigitos(str) {
  return (str || '').replace(/\D/g, '');
}

/**
 * Busca el comercial por teléfono comparando solo los últimos 9
 * dígitos (no igualdad exacta) — Twilio manda "whatsapp:+34..." y el
 * formato guardado en la tabla puede variar (con/sin prefijo, con/sin
 * espacios). Se trae solo la cartera de activos (pocas filas) y se
 * compara en JS.
 */
async function buscarComercial(telefono) {
  const digitosBuscados = soloDigitos(telefono).slice(-9);
  if (!digitosBuscados) return null;

  const { data } = await supabase
    .from('comerciales')
    .select('*')
    .eq('activo', true)
    .eq('empresa', getEmpresaActiva());

  return (data || []).find((c) => soloDigitos(c.telefono).slice(-9) === digitosBuscados) || null;
}

const PENDIENTES = ['not_paid', 'partial'];

function formatearResumenCuenta(clienteNombre, facturas) {
  const pendientes = facturas.filter((f) => PENDIENTES.includes(f.payment_state));
  const totalPendiente = pendientes.reduce((s, f) => s + (f.amount_residual || 0), 0);
  const masAntigua = pendientes.filter((f) => !f.rectificativa).sort((a, b) => new Date(a.invoice_date) - new Date(b.invoice_date))[0];
  const numRect = pendientes.filter((f) => f.rectificativa).length;
  const numParciales = pendientes.filter((f) => f.payment_state === 'partial').length;

  let texto = `🧾 *Estado de cuenta — ${clienteNombre}*\nFacturas pendientes: ${pendientes.length}\nImporte total pendiente: ${totalPendiente.toFixed(2)} €`;
  if (numParciales > 0) {
    texto += `\n(${numParciales} con pago parcial ya descontado)`;
  }
  if (numRect > 0) {
    texto += `\n(${numRect} ${numRect === 1 ? 'rectificativa' : 'rectificativas'} a su favor ya descontada${numRect === 1 ? '' : 's'})`;
  }
  if (masAntigua) {
    texto += `\nMás antigua sin pagar: ${masAntigua.name} (${masAntigua.invoice_date})`;
  }
  return texto;
}

function formatearListaPendientes(clienteNombre, facturas) {
  const pendientes = facturas.filter((f) => PENDIENTES.includes(f.payment_state));
  if (pendientes.length === 0) {
    return `✅ *${clienteNombre}* no tiene facturas pendientes de pago.`;
  }
  const lista = pendientes.slice(0, 10).map((f) => {
    if (f.rectificativa) {
      return `• 🔄 ${f.name} — ${f.invoice_date} — ${f.amount_residual.toFixed(2)} € (rectificativa a su favor)`;
    }
    if (f.payment_state === 'partial') {
      const pagado = (f.amount_total || 0) - (f.amount_residual || 0);
      return `• ${f.name} — ${f.invoice_date} — total ${f.amount_total.toFixed(2)} € · pagado ${pagado.toFixed(2)} € · pendiente ${f.amount_residual.toFixed(2)} €`;
    }
    return `• ${f.name} — ${f.invoice_date} — ${f.amount_residual.toFixed(2)} € pendiente`;
  }).join('\n');
  const extra = pendientes.length > 10 ? `\n(y ${pendientes.length - 10} más...)` : '';
  const total = pendientes.reduce((acc, f) => acc + (f.amount_residual || 0), 0);
  const hayRect = pendientes.some((f) => f.rectificativa);
  const lineaTotal = `\n\n*Total pendiente: ${total.toFixed(2)} €*${hayRect ? ' (ya descontadas las rectificativas)' : ''}`;
  return `🧾 *Facturas pendientes — ${clienteNombre}*\n\n${lista}${extra}${lineaTotal}`;
}

function formatEuro(n) {
  return `${n.toFixed(2).replace('.', ',')} €`;
}

/**
 * Mismo contenido que formatearListaPendientes pero en el tono y
 * formato pensado para reenviar TAL CUAL al cliente (sin emojis
 * internos, con el total y una frase de cierre pidiendo previsión de
 * pago) — el comercial lo pide con el comando "reenviar" después de
 * consultar la opción 2 del menú de facturas. Las pagadas en parte
 * muestran el desglose completo, para que el cliente vea claramente
 * que ya se ha descontado lo que pagó y no se le está pidiendo el
 * total de la factura otra vez.
 */
function formatearListaPendientesParaCliente(facturas) {
  const pendientes = facturas.filter((f) => PENDIENTES.includes(f.payment_state));
  if (pendientes.length === 0) return null;
  const total = pendientes.reduce((s, f) => s + (f.amount_residual || 0), 0);
  const lista = pendientes.map((f) => {
    if (f.rectificativa) {
      return `* ${f.name} (${f.invoice_date}) — ${formatEuro(f.amount_residual)} (abono a vuestro favor)`;
    }
    if (f.payment_state === 'partial') {
      const pagado = (f.amount_total || 0) - (f.amount_residual || 0);
      return `* ${f.name} (${f.invoice_date}) — total ${formatEuro(f.amount_total)}, pagado ${formatEuro(pagado)}, pendiente ${formatEuro(f.amount_residual)}`;
    }
    return `* ${f.name} (${f.invoice_date}) — ${formatEuro(f.amount_residual)}`;
  }).join('\n');
  const pdf = '\nTe adjunto también las facturas en PDF.';
  return `Te paso el detalle actualizado de facturas pendientes:\n${lista}\nTotal pendiente: ${formatEuro(total)}${pdf}\nCuando puedas, revísalo y dime previsión de pago.\nSi hay cualquier diferencia, lo revisamos.`;
}

function formatearUltimaFactura(clienteNombre, todas) {
  const facturas = todas.filter((f) => !f.rectificativa);
  if (facturas.length === 0) {
    return `No hay facturas registradas para *${clienteNombre}*.`;
  }
  const f = facturas[0]; // ya vienen ordenadas por fecha desc
  const estado = f.payment_state === 'paid' ? '✅ Pagada' : '⏳ Pendiente';
  return `🧾 *Última factura — ${clienteNombre}*\n${f.name} — ${f.invoice_date}\nImporte: ${f.amount_total.toFixed(2)} € · ${estado}`;
}

const MENU_FACTURAS = (nombre) =>
  `Cliente: *${nombre}*\n\n1️⃣ Resumen de cuenta\n2️⃣ Facturas pendientes de pago\n3️⃣ Última factura\n4️⃣ Todas las pendientes (PDF combinado)\n5️⃣ Informe de cuenta (PDF para reenviar al cliente)\n6️⃣ Facturas de un trimestre (PDF)\n\nResponde con el número, escribe *alias <nombre>* para guardarle un atajo, o *menu* para volver al principio.`;

// ------------------------------------------------------------
// Trimestres para la opción 6 de FACTURAS
// ------------------------------------------------------------
function ultimosTrimestres(n = 6, hoy = new Date()) {
  const lista = [];
  let anio = hoy.getFullYear();
  let q = Math.floor(hoy.getMonth() / 3) + 1;
  for (let i = 0; i < n; i++) {
    lista.push({ q, anio });
    q -= 1;
    if (q === 0) { q = 4; anio -= 1; }
  }
  return lista;
}

function datosTrimestre(q, anio) {
  const mesIni = (q - 1) * 3 + 1;
  const mesFin = mesIni + 2;
  const ultimoDia = new Date(anio, mesFin, 0).getDate();
  const dos = (n) => String(n).padStart(2, '0');
  return {
    q,
    anio,
    desde: `${anio}-${dos(mesIni)}-01`,
    hasta: `${anio}-${dos(mesFin)}-${dos(ultimoDia)}`,
    nombre: `${q}º trimestre de ${anio}`,
  };
}

function menuTrimestres(clienteNombre) {
  const hoy = new Date();
  const actual = Math.floor(hoy.getMonth() / 3) + 1;
  const lineas = ultimosTrimestres(6, hoy).map(({ q, anio }, i) => {
    const enCurso = q === actual && anio === hoy.getFullYear() ? ' (en curso)' : '';
    return `${i + 1}️⃣ ${q}T ${anio}${enCurso}`;
  });
  return `🧾 *Facturas por trimestre — ${clienteNombre}*\n\n${lineas.join('\n')}\n\nResponde con el número, o escribe otro trimestre así: *3T 2024*.\nEscribe *menu* para volver al principio.`;
}

/** '2' → la 2ª opción de la lista · '3T 2025', 'T3 2025', '3 2025', '3t25' → ese trimestre. */
function interpretarTrimestre(textoOriginal) {
  const t = (textoOriginal || '').trim().toLowerCase();
  if (/^[1-6]$/.test(t)) {
    const { q, anio } = ultimosTrimestres(6)[Number(t) - 1];
    return datosTrimestre(q, anio);
  }
  const m = t.match(/^(?:t\s*)?([1-4])\s*(?:º|o|er)?\s*(?:t|trim(?:estre)?)?\s*(?:de\s+|del\s+|\/|-)?\s*(\d{2}|\d{4})$/);
  if (!m) return null;
  let anio = Number(m[2]);
  if (anio < 100) anio += 2000;
  if (anio < 2015 || anio > new Date().getFullYear()) return null;
  return datosTrimestre(Number(m[1]), anio);
}

const MENU_VISUAL = `1️⃣ Catálogos (PDF)\n2️⃣ Galería de fotos\n\nResponde con el número, o escribe *menu* para volver al principio.`;

const MENU_GALERIA = `📸 Galería de fotos\n\n1️⃣ Ver galería (enlace web)\n2️⃣ Subir una foto\n\nResponde con el número, o escribe *menu* para volver al principio.`;

function formatearDirecciones(direcciones) {
  return direcciones.map((d, i) => `${i + 1}. ${d.name}${d.street ? ` — ${d.street}` : ''}${d.city ? `, ${d.city}` : ''}`).join('\n');
}


/**
 * Los textos de "no identificado" suelen venir como "2 Cabiar de mango
 * de 250" — separa la cantidad inicial del nombre, para no tener que
 * volver a preguntarla al emparejar con N1/N2/...
 */
function extraerCantidadYNombre(texto) {
  const m = texto.match(/^(\d+(?:[.,]\d+)?)\s+(.+)$/);
  if (m) return { cantidad: parseFloat(m[1].replace(',', '.')), nombre: m[2] };
  return { cantidad: 1, nombre: texto };
}

/**
 * Tras elegir cliente para un pedido, consulta sus direcciones de
 * entrega: si hay más de una, pide elegir; si hay 0 o 1, sigue directo
 * (usando esa única dirección, o el propio cliente como dirección si
 * no tiene ninguna guardada).
 */
/**
 * Entra al submenú de Facturas para un cliente ya identificado,
 * resolviendo primero al cliente comercial real (empresa), igual que
 * en el flujo de pedido.
 */
const MENU_CLIENTE = (nombre) =>
  `Cliente: *${nombre}*\n\n1️⃣ Facturas\n2️⃣ Estudio\n3️⃣ Pedido\n4️⃣ Seguimiento\n5️⃣ Consumo del año (Excel)\n6️⃣ Fichas técnicas de sus productos (PDF)\n7️⃣ Informe 360 (web para tablet/PC)\n8️⃣ Estudio de su carta (enlace, PDF o foto)\n9️⃣ Catálogo a medida (web: eliges artículos y se lo mandas)\n🔟 Pedido y carta en la web (rápido, sin informe)\n\nResponde con el número, o *menu* para volver al principio.`;

/**
 * Punto de entrada único tras elegir un cliente: resuelve al cliente
 * comercial real UNA vez, y deja un mini-menú con las cuatro cosas
 * que se pueden hacer con él (facturas/estudio/pedido/seguimiento) sin
 * tener que volver a buscarlo entre una y otra.
 */
// --- Pedidos reenviados (ver "PEDIDO REENVIADO" en procesarMensajeInterno) ---
const TEXTO_QUE_CLIENTE = '¿De qué cliente es? Escribe su nombre o alias (ej. *gansa*) y te paso el enlace web con el pedido ya cargado: solo tendrás que pulsar *Interpretar*.\n\nSi el pedido viene en varias fotos o mensajes, reenvíalos ahora y se juntan. O escribe *menu* para salir.';
const TEXTO_PEDIDO_ANADIDO = '➕ Añadido al mismo pedido. ¿De qué cliente es? Escribe su nombre o alias (ej. *gansa*).';
/** "web gansa" / "pedido web gansa" / "360 web gansa" → "gansa" (si no, null) */
function clienteDePie(texto) {
  const m = /^\s*(?:(?:pedido|360)\s+)?web\s+(.{2,})$/i.exec(String(texto || '').split(/\r?\n/)[0]);
  return m ? m[1].trim() : null;
}
/** Busca el cliente y abre la opción 10 (pedido web), que carga los pedidos reenviados pendientes. */
async function pedirEnlacePedidoWeb(telefono, comercial, nombreCliente) {
  await guardarSesion(telefono, 'esperando_cliente', { odoo_user_id: comercial.odoo_user_id, destino: '10' });
  return procesarMensajeInterno(telefono, nombreCliente);
}

async function entrarMenuCliente(telefono, clienteId, clienteNombre, destino = null) {
  try {
    const resuelto = await resolverClienteComercial(clienteId);
    if (resuelto.id !== clienteId) {
      clienteId = resuelto.id;
      clienteNombre = resuelto.name || clienteNombre;
    }
  } catch (err) {
    console.error('Error resolviendo cliente comercial (se sigue con el original):', err);
  }
  await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
  // Atajo ("facturas gansa", "pedido gansa"…): se entra directo en la opción
  if (destino) return procesarMensajeInterno(telefono, destino);
  return { texto: MENU_CLIENTE(clienteNombre) };
}

async function entrarMenuFacturas(telefono, clienteId, clienteNombre) {
  try {
    const resuelto = await resolverClienteComercial(clienteId);
    if (resuelto.id !== clienteId) {
      clienteId = resuelto.id;
      clienteNombre = resuelto.name || clienteNombre;
    }
  } catch (err) {
    console.error('Error resolviendo cliente comercial (se sigue con el original):', err);
  }
  await guardarSesion(telefono, 'menu_facturas', { clienteId, clienteNombre });
  return { texto: MENU_FACTURAS(clienteNombre) };
}

const MENU_SEGUIMIENTO = (nombre) =>
  `Cliente: *${nombre}*\n\n1️⃣ En reparto (esta semana)\n2️⃣ Repartidos (esta semana)\n3️⃣ Sin confirmar (esta semana)\n4️⃣ Pedidos anteriores (buscar más atrás)\n5️⃣ Todo (resumen semanal)\n\nResponde con el número, o *menu* para volver al principio.`;

async function entrarMenuSeguimiento(telefono, clienteId, clienteNombre) {
  try {
    const resuelto = await resolverClienteComercial(clienteId);
    if (resuelto.id !== clienteId) {
      clienteId = resuelto.id;
      clienteNombre = resuelto.name || clienteNombre;
    }
  } catch (err) {
    console.error('Error resolviendo cliente comercial (se sigue con el original):', err);
  }
  await guardarSesion(telefono, 'menu_seguimiento', { clienteId, clienteNombre });
  return { texto: MENU_SEGUIMIENTO(clienteNombre) };
}

/**
 * Resuelve al cliente comercial real, genera el estudio completo (esto
 * es lo que se llama tras localizar el cliente, no toma "telefono" —
 * lo guarda quien lo invoca), y devuelve el texto listo para responder.
 */
async function generarEstudioParaCliente(clienteId, clienteNombre) {
  try {
    const resuelto = await resolverClienteComercial(clienteId);
    if (resuelto.id !== clienteId) {
      clienteId = resuelto.id;
      clienteNombre = resuelto.name || clienteNombre;
    }
  } catch (err) {
    console.error('Error resolviendo cliente comercial (se sigue con el original):', err);
  }
  try {
    return await generarEstudioCliente(clienteId, clienteNombre);
  } catch (err) {
    console.error('Error generando estudio de cliente:', err);
    return `⚠️ No he podido generar el estudio de *${clienteNombre}* ahora mismo. Inténtalo de nuevo en unos minutos.`;
  }
}

async function finalizarEstudio(telefono, clienteId, clienteNombre) {
  const textoEstudio = await generarEstudioParaCliente(clienteId, clienteNombre);
  await guardarSesion(telefono, 'menu', null);
  return { texto: `${textoEstudio}\n\nEscribe *menu* para otra consulta.` };
}

async function iniciarSeleccionDireccion(telefono, clienteId, clienteNombre) {
  try {
    const resuelto = await resolverClienteComercial(clienteId);
    if (resuelto.id !== clienteId) {
      clienteId = resuelto.id;
      clienteNombre = resuelto.name || clienteNombre;
    }
  } catch (err) {
    console.error('Error resolviendo cliente comercial (se sigue con el original):', err);
  }

  const lineaDeuda = await lineaDeudaSemaforo(clienteId);
  const deudaTexto = lineaDeuda ? `\n${lineaDeuda}` : '';

  // La consulta de direcciones (login web a Odoo a través del VPS)
  // puede tardar más de lo que Twilio espera dentro de esta misma
  // respuesta, así que se dispara en segundo plano — aquí solo se
  // avisa de que está en camino.
  const empresa = getEmpresaActiva();
  await guardarSesion(telefono, 'buscando_direcciones', { clienteId, clienteNombre });
  try {
    await fetch(`${SITE_URL}/.netlify/functions/buscar-direcciones-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telefono, empresa, clienteId, clienteNombre }),
    });
  } catch (err) {
    console.error('Error lanzando buscar-direcciones-background:', err);
  }

  return { texto: `Cliente: *${clienteNombre}*.${deudaTexto}\n\n🔍 Buscando sus direcciones, dame un momento...` };
}



// ------------------------------------------------------------
// Procesa un mensaje y devuelve { texto, mediaUrl? }
// ------------------------------------------------------------
async function procesarMensajeInterno(telefono, textoOriginal, media = null, opciones = {}) {
  textoOriginal = (textoOriginal || '').trim();
  const texto = textoOriginal.toLowerCase();

  if (!telefono || (!textoOriginal && !media)) {
    return { texto: 'No he recibido ningún mensaje.' };
  }

  // Puerta de acceso: si el número no está en el registro de comerciales,
  // no se procesa nada más (ni siquiera se muestra el menú). Así evitamos
  // que cualquiera que consiga el número de WhatsApp pueda consultar
  // stock, catálogos o facturas.
  const comercial = await buscarComercial(telefono);
  if (!comercial) {
    // Puede ser un cliente respondiendo a un aviso de productos
    // habituales no pedidos — se detecta por teléfono y se avisa al
    // comercial correspondiente por WhatsApp; el bot no media la
    // conversación real con el cliente a partir de ahí.
    let clienteAutorizadoAhora = false;
    let comercialYaAvisado = false;
    try {
      const aviso = await intentarRelevarRespuestaCliente(telefono);
      if (aviso) {
        if (aviso.origen === 'presentacion_copiloto') {
          // El cliente ha aceptado la presentación de Copiloto — como
          // fuimos NOSOTROS quienes le mandamos la plantilla a un
          // contacto ya verificado por un comercial, ya sabemos a qué
          // cliente pertenece: se autoriza directamente, sin pasos
          // manuales adicionales.
          try {
            await autorizarTelefono({
              empresa: aviso.empresa,
              clienteId: aviso.cliente_id,
              clienteNombre: aviso.cliente_nombre,
              telefono: aviso.telefono,
              nombreContacto: aviso.variables?.[1] || null,
              autorizadoPor: 'auto: aceptó plantilla de presentación',
            });
            clienteAutorizadoAhora = true;
          } catch (errAutorizar) {
            console.error('Error autorizando teléfono tras aceptar presentación:', errAutorizar);
          }
        } else {
          try {
            await enviarMensajeLibre({
              to: `whatsapp:${aviso.comercial_telefono}`,
              body: `📩 *${aviso.cliente_nombre}* ha respondido al aviso de productos habituales no pedidos. Contacta con él/ella directamente: ${aviso.telefono}`,
            });
            comercialYaAvisado = true;
          } catch (errNotif) {
            console.error('Error notificando al comercial de la respuesta del cliente:', errNotif);
          }
        }
      }
    } catch (errRelevo) {
      console.error('Error comprobando si es un cliente respondiendo a un aviso:', errRelevo);
    }

    if (clienteAutorizadoAhora) {
      return { texto: '✅ ¡Perfecto! Ya tienes activado a Copiloto.\n\nMuy pronto podrás consultar aquí mismo tu stock, tarifa, facturas y más. Te avisaremos en cuanto esté listo.' };
    }
    // Cualquier otro (cliente, local de la prospección, alguien que llega
    // desde una tarjeta de visita…): respuesta útil y su mensaje al comercial.
    try {
      return await require('./contactoExterno').atenderNoComercial({
        empresa: getEmpresaActiva(), telefono, texto: textoOriginal, tieneMedia: !!media, yaAvisado: comercialYaAvisado,
      });
    } catch (errExterno) {
      console.error('Error atendiendo a un número que no es comercial:', errExterno);
      return { texto: 'Gracias por escribirnos. Tu comercial te contesta en breve.' };
    }
  }

  // "no avisar" cancela el último aviso al cliente programado por este
  // comercial, si todavía está dentro del margen de cancelación.
  if (texto === 'no avisar') {
    try {
      const cancelado = await cancelarUltimoAviso(comercial.telefono);
      if (!cancelado) {
        return { texto: 'No tienes ningún aviso a cliente pendiente de cancelar ahora mismo.' };
      }
      return { texto: `✅ Aviso a *${cancelado.cliente_nombre}* cancelado. No se enviará.` };
    } catch (err) {
      console.error('Error cancelando aviso a cliente:', err);
      return { texto: '⚠️ No he podido cancelar el aviso. Inténtalo de nuevo.' };
    }
  }

  // "menu" en cualquier momento reinicia la conversación
  if (texto === 'menu' || texto === 'menú') {
    await guardarSesion(telefono, 'menu', null);
    return { texto: MENSAJE_MENU };
  }

  const sesion = await getSesion(telefono);

  // "reportar" desde cualquier punto: guarda dónde estaba el comercial
  // y le pide qué ha pasado (ver feedback.js).
  if (texto === 'reportar' && !ESTADOS_FEEDBACK.includes(sesion.estado)) {
    return iniciarReporte(telefono, sesion, guardarSesion);
  }

  if (ESTADOS_FEEDBACK.includes(sesion.estado)) {
    const resultadoFb = await manejarFeedback({ telefono, textoOriginal, media, sesion, comercial, guardarSesion, MENSAJE_MENU });
    if (resultadoFb) return resultadoFb;
  }

  // Foto reenviada a Copiloto fuera de un paso que la espere (galería o
  // pedido por WhatsApp): normalmente es el pedido que ha mandado un
  // cliente. Se guarda 48 h para usarla en Informe 360 → Hacer pedido.
  const ESTADOS_QUE_ESPERAN_FOTO = ['esperando_foto', 'esperando_texto_pedido', 'esperando_carta', 'esperando_foto_perfil'];
  if (media && (media.contentType || '').startsWith('image/') && !ESTADOS_QUE_ESPERAN_FOTO.includes(sesion.estado)) {
    try {
      const empresa = getEmpresaActiva();
      const foto = await guardarFotoRecibida({ telefono, empresa, media });
      const yaHabia = sesion.estado === 'pedido_recibido';
      await guardarPedidoRecibido({ empresa, telefono, tipo: 'foto', fotoId: foto.id, nuevoLote: !yaHabia });
      // Foto con el texto "web gansa": directo al enlace con la foto cargada
      const cli = clienteDePie(textoOriginal);
      if (cli) return pedirEnlacePedidoWeb(telefono, comercial, cli);
      await guardarSesion(telefono, 'pedido_recibido', null);
      return { texto: yaHabia ? TEXTO_PEDIDO_ANADIDO : `📷 *Pedido recibido* (foto).\n\n${TEXTO_QUE_CLIENTE}` };
    } catch (err) {
      console.error('Error guardando la foto reenviada:', err);
      return { texto: '⚠️ No he podido guardar la foto. Inténtalo de nuevo, o escribe *menu*.' };
    }
  }

  // Usuarios de CONSULTA: sin cartera de clientes, así que CLIENTE
  // (facturas, estudio, pedido, seguimiento) y MIS DATOS no aplican.
  if (esConsulta(comercial)) {
    const pideCliente = /^(clientes?|facturas?|estudio|pedido|seguimiento|consumo|fichas?\s+(del?\s+)?cliente)\b/i.test(textoOriginal)
      || (sesion.estado === 'menu' && (texto === '3' || texto === '4' || texto.includes('mis datos')));
    if (pideCliente) {
      await guardarSesion(telefono, 'menu', null);
      return { texto: `Esa opción es solo para comerciales con clientes asignados.\n\n${MENSAJE_MENU_CONSULTA}` };
    }
  }

  // ------------------------------------------------------------
  // ATAJOS: "catalogo asiatico", "stock hamburguesa angus",
  // "cliente gansa", "facturas gansa", "estudio gansa", "pedido gansa",
  // "seguimiento gansa", "360 gansa" (o "informe 360 gansa"). Funcionan desde el menú y desde cualquier
  // submenú o lista numerada; NO cuando Copiloto está esperando que
  // escribas algo (un pedido, una tarea, un nombre…), para no cortar.
  // ------------------------------------------------------------
  const estadoNavegacion = !sesion.estado || sesion.estado === 'menu' || sesion.estado.startsWith('menu_')
    || sesion.estado === 'esperando_catalogo'
    // Esperando un nombre de producto o de cliente: si escribe "ficha
    // espirales" o "fichas cliente roysa" es claramente un atajo, no el
    // nombre que se le pedía (antes se buscaba la frase entera y no salía)
    || /^esperando_(producto|cliente)/.test(sesion.estado)
    || (sesion.estado.startsWith('esperando_seleccion') && !sesion.estado.includes('pedido')); // en mitad de un pedido, no
  // ------------------------------------------------------------
  // PEDIDO REENVIADO (texto): el comercial reenvía a Copiloto el pedido
  // que le ha mandado el cliente. Se guarda y se pregunta de qué cliente
  // es; con el nombre, va el enlace web del pedido con el texto cargado.
  // ------------------------------------------------------------
  if (!media && textoOriginal && (estadoNavegacion || sesion.estado === 'pedido_recibido') && !esConsulta(comercial)) {
    const lineas = textoOriginal.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const cabecera = lineas.length > 1 ? clienteDePie(lineas[0]) : null;   // "web gansa" + el pedido debajo
    const pareceListado = lineas.length >= 2 && lineas.filter((l) => /\d/.test(l)).length >= 1;
    // Si Copiloto espera un dato (un producto, un cliente…), un reenvío suelto no se toma como pedido
    const enEspera = /^esperando_/.test(sesion.estado || '');
    if ((opciones.reenviado && !enEspera) || (pareceListado && !enEspera) || cabecera) {
      const cuerpo = cabecera ? lineas.slice(1).join('\n') : textoOriginal.trim();
      const yaHabia = sesion.estado === 'pedido_recibido';
      try {
        await guardarPedidoRecibido({ empresa: getEmpresaActiva(), telefono, tipo: 'texto', texto: cuerpo.slice(0, 6000), nuevoLote: !yaHabia });
      } catch (err) {
        console.error('Error guardando el pedido reenviado:', err);
        return { texto: '⚠️ No he podido guardar el pedido. Inténtalo de nuevo, o escribe *menu*.' };
      }
      if (cabecera) return pedirEnlacePedidoWeb(telefono, comercial, cabecera);
      await guardarSesion(telefono, 'pedido_recibido', null);
      const n = cuerpo.split(/\r?\n/).filter((l) => l.trim()).length;
      return { texto: yaHabia ? TEXTO_PEDIDO_ANADIDO : `📥 *Pedido recibido* (${n} ${n === 1 ? 'línea' : 'líneas'}).\n\n${TEXTO_QUE_CLIENTE}` };
    }
    // Esperando el cliente del pedido reenviado: lo que escriba es el cliente
    if (sesion.estado === 'pedido_recibido') {
      const nombre = clienteDePie(textoOriginal) || textoOriginal.trim().replace(/^(?:cliente|pedido|para)\s+/i, '');
      if (nombre.length < 2) return { texto: 'Escribe el nombre o alias del cliente (ej. *gansa*), o *menu* para salir.' };
      return pedirEnlacePedidoWeb(telefono, comercial, nombre);
    }
  }

  // "fichas cliente gansa" / "fichas del cliente gansa" → fichas técnicas
  // de todos los productos de ese cliente (CLIENTE → 6)
  const atajoFichasCliente = estadoNavegacion ? /^fichas?\s+(?:del?\s+)?cliente\s+(.{2,})$/i.exec(textoOriginal) : null;
  if (atajoFichasCliente) {
    await guardarSesion(telefono, 'esperando_cliente', { odoo_user_id: comercial.odoo_user_id, destino: '6' });
    return procesarMensajeInterno(telefono, atajoFichasCliente[1].trim());
  }

  // "carta nueva <local>" (o "prospecto <local>"): estudio de carta de un local
  // que AÚN NO es cliente (puerta fría). No se busca en Odoo.
  // "mi foto": la foto del comercial para las páginas y tarjetas de primer contacto
  if (estadoNavegacion && /^mi\s+foto$/i.test(textoOriginal.trim())) {
    await guardarSesion(telefono, 'esperando_foto_perfil');
    return { texto: '📸 Mándame tu foto (de frente, con buena luz y fondo liso). Saldrá en las páginas y tarjetas de primer contacto que prepares. O escribe *menu* para salir.' };
  }
  // "mi tarjeta": tarjeta de visita digital del comercial (para dar, reenviar o imprimir)
  if (estadoNavegacion && /^(mi\s+)?tarjeta(\s+de\s+visita)?$/i.test(textoOriginal.trim())) {
    const { urlTarjetaVisita } = require('./tarjetaVisita');
    const empresa = getEmpresaActiva();
    const url = urlTarjetaVisita(empresa, comercial.telefono);
    // 1) Mensaje listo para reenviar al cliente: WhatsApp le enseña la tarjeta (foto, nombre, cargo) sin abrir nada
    const nombreEmpresa = (require('./primerContacto').EMPRESAS[empresa] || {}).nombre || '';
    const quien = comercial.nombre_tarjeta || comercial.nombre || '';
    try {
      await enviarMensajeLibre({ to: telefono, body: `Hola 👋 Soy ${quien}, de ${nombreEmpresa}. Te dejo mi tarjeta: desde ella puedes escribirme, llamarme, guardar mi contacto o hacer tu pedido por WhatsApp.\n\n${url}` });
    } catch (e) { console.error('Error enviando la tarjeta para reenviar:', e.message); }
    // 2) Instrucciones para el comercial (llegan después)
    return { texto: `🪪 👆 *Reenvía ese mensaje al cliente*: en su WhatsApp se ve tu tarjeta con tu foto, nombre y cargo; al tocarla se abre entera.\n\nPara imprimirla (85 × 55 mm, con QR):\n${process.env.SITE_URL}/visita.html?e=${empresa}&c=${url.split('/').pop()}&imprimir=1${comercial.foto_url ? '' : '\n\n📸 Aún no tienes foto: escribe *mi foto* para ponerla (sale en la vista previa).'}` };
  }
  // "permiso la resolana javier 600111222": permiso de WhatsApp de un local (prospección) y envío de su propuesta
  const atajoPermiso = estadoNavegacion ? /^permiso\s+(.{3,})$/i.exec(textoOriginal.trim()) : null;
  if (atajoPermiso && !esConsulta(comercial)) return iniciarPermiso(telefono, atajoPermiso[1]);

  // "prospectar el viso del alcor": locales del municipio para captar clientes
  const atajoProspeccion = estadoNavegacion ? /^(?:prospectar|prospecci[oó]n|prospeccion)\s+(?:en\s+)?(.{3,})$/i.exec(textoOriginal) : null;
  if (atajoProspeccion && !esConsulta(comercial)) {
    const municipio = nombreMunicipio(atajoProspeccion[1]);
    const grupos = require('./prospeccion').gruposDe(getEmpresaActiva());
    if (grupos.length === 1) return lanzarProspeccion(telefono, comercial, municipio, grupos[0].clave);
    await guardarSesion(telefono, 'esperando_grupo_prospeccion', { municipio, grupos });
    return { texto: `🧭 ¿Qué buscamos en *${municipio}*?\n\n${grupos.map((g, i) => `${i + 1} ${g.nombre}`).join('\n')}\n\nO escribe *menu* para salir.` };
  }

  const atajoProspecto = estadoNavegacion ? /^(?:carta\s+(?:nueva|prospecto|fr[ií]a)|prospecto)\s+(.{2,})$/i.exec(textoOriginal) : null;
  if (atajoProspecto) {
    const local = atajoProspecto[1].trim().slice(0, 80);
    await guardarSesion(telefono, 'esperando_carta', { prospecto: local });
    return { texto: `📖 *Estudio de carta — ${local}* (aún no es cliente)\n\nMándame la carta:\n• el *enlace* de su web,\n• el *PDF*, o\n• una o varias *fotos* (de una en una).\n\nTe digo qué productos nuestros encajan con sus platos, con nuestro coste para que pongas precio y saques una propuesta. O escribe *menu* para salir.` };
  }

  const atajo = estadoNavegacion ? /^(cat[aá]logos?|stock|fichas?|clientes?|facturas?|estudio|pedido|seguimiento|consumo|360|informe|carta|selecci[oó]n|medida|web)\s+(.{2,})$/i.exec(textoOriginal) : null;
  if (atajo) {
    let clave = atajo[1].toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // "informe 360 gansa" → el "360" sobra, el cliente es "gansa"
    let argumento = clave === 'informe' ? atajo[2].trim().replace(/^360\s+/, '') : atajo[2].trim();
    // "pedido web gansa" (o "360 web gansa") = "web gansa": pedido y carta en la web, sin preparar el 360
    if ((clave === 'pedido' || clave === '360') && /^web\s+/i.test(argumento)) { clave = 'web'; argumento = argumento.replace(/^web\s+/i, ''); }

    // "ficha hamburguesa angus" (o "fichas …") → la ficha técnica en PDF
    if (clave === 'ficha' || clave === 'fichas') {
      return buscarYResponderFicha(telefono, argumento);
    }

    if (clave.startsWith('catalogo')) {
      const catalogos = await listarCatalogos();
      const sinTilde = (t) => (t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const palabras = palabrasBusqueda(argumento).map(sinTilde);
      const buscar = (ps) => catalogos.filter((c) => {
        const nombre = sinTilde(`${c.familia} ${c.archivo}`);
        return ps.every((p) => nombre.includes(p));
      });
      let coinciden = buscar(palabras);
      // Si no sale, se prueba con el principio de cada palabra
      // ("burger" → "burg" encuentra "Burguer")
      if (coinciden.length === 0) coinciden = buscar(palabras.map((p) => p.slice(0, 4)));
      if (coinciden.length === 1) {
        await guardarSesion(telefono, 'esperando_catalogo', { catalogos });
        return respuestaCatalogo(coinciden[0], '¿Necesitas otro? Escribe *catalogo* y el nombre, o *menu*.');
      }
      const lista = coinciden.length > 1 ? coinciden : catalogos;
      await guardarSesion(telefono, 'esperando_catalogo', { catalogos: lista });
      const cabecera = coinciden.length > 1
        ? `Hay varios catálogos con "${argumento}":`
        : `No tengo ningún catálogo con "${argumento}". Estos son los que hay:`;
      return { texto: `${cabecera}\n\n${lista.map((c, i) => `${i + 1}. ${c.familia}`).join('\n')}\n\nResponde con el número.` };
    }

    if (clave === 'stock') {
      await guardarSesion(telefono, 'esperando_producto');
      return procesarMensajeInterno(telefono, argumento);
    }

    // Cliente y sus opciones: se busca el cliente y se entra directo
    const DESTINOS = { factura: '1', facturas: '1', estudio: '2', pedido: '3', seguimiento: '4', consumo: '5', 360: '7', informe: '7', carta: '8', seleccion: '9', medida: '9', web: '10' };
    await guardarSesion(telefono, 'esperando_cliente', {
      odoo_user_id: comercial.odoo_user_id,
      destino: DESTINOS[clave] || null,
    });
    return procesarMensajeInterno(telefono, argumento);
  }

  // ------------------------------------------------------------
  // Paso: menú principal
  // ------------------------------------------------------------
  if (sesion.estado === 'menu') {
    // "ficha" justo después de consultar el stock de un producto
    const ultimoProducto = sesion.contexto?.ultimo_producto;
    // "r" justo después de STOCK: preparar el mensaje para el cliente
    if ((texto === 'r' || texto === 'reenviar') && ultimoProducto && ultimoProducto.stock !== undefined) {
      await guardarSesion(telefono, 'esperando_precio_cliente', { producto: ultimoProducto });
      const opcionMedia = (!esConsulta(comercial) && ultimoProducto.precio_medio != null)
        ? `\n• *m* → la venta media (${euros(ultimoProducto.precio_medio)} / ${ultimoProducto.unidad})`
        : '';
      return {
        texto: `💶 ¿Qué precio le pongo al cliente (sin IVA, por ${ultimoProducto.unidad})?\n\n• Escribe el precio (ej. *11,90*)${opcionMedia}\n• *0* → sin precio`,
      };
    }
    if ((texto === 'ficha' || texto === 'fichas' || texto === 'ficha tecnica' || texto === 'ficha técnica') && ultimoProducto) {
      return responderFicha(telefono, ultimoProducto);
    }
    // "otros pdf": el artículo tiene más PDF además de la ficha enviada
    if ((texto === 'otros pdf' || texto === 'otros') && ultimoProducto) {
      return responderFicha(telefono, ultimoProducto, true);
    }

    if (texto === '8' || texto.includes('ficha')) {
      await guardarSesion(telefono, 'esperando_producto_ficha', { todas: false });
      return { texto: '📑 ¿De qué producto quieres la ficha técnica? Escribe el nombre o la referencia (ej. *hamburguesa angus*).' };
    }

    if (texto === '1' || texto.includes('stock')) {
      await guardarSesion(telefono, 'esperando_producto');
      return { texto: 'Escribe el nombre del producto. Puedes poner varias palabras para afinar (ej. *hamburguesa angus*).' };
    }

    if (texto === '2' || texto.includes('catalog') || texto.includes('galeria') || texto.includes('galería') || texto.includes('visual')) {
      await guardarSesion(telefono, 'menu_visual');
      return { texto: MENU_VISUAL };
    }

    if (texto === '3' || texto.includes('cliente') || texto.includes('factura') || texto.includes('pedido') || texto.includes('estudio') || texto.includes('seguimiento')) {
      await guardarSesion(telefono, 'esperando_cliente', { odoo_user_id: comercial.odoo_user_id });
      return { texto: 'Escribe el nombre del cliente.' };
    }

    if (texto === '4' || texto.includes('mis datos')) {
      if (!comercial.odoo_user_id) {
        return { texto: `*MIS DATOS* muestra las ventas y la cartera de un comercial, y tu usuario no tiene comercial de Odoo asociado.\n\nPara consultar cualquier cliente usa *3 CLIENTE*.\n\n${MENSAJE_MENU}` };
      }
      await guardarSesion(telefono, 'menu_mis_datos', { odoo_user_id: comercial.odoo_user_id, comercial_id: comercial.odoo_user_id });
      return { texto: MENU_MIS_DATOS };
    }

    if (texto === '5' || texto.includes('enlace')) {
      await guardarSesion(telefono, 'menu', null);
      const enlaces = await listarEnlaces();
      return { texto: `${formatearEnlaces(enlaces)}\n\nEscribe *menu* para otra consulta.` };
    }

    if (texto === '6' || texto.includes('tarea')) {
      await guardarSesion(telefono, 'menu_tareas', null);
      return { texto: MENU_TAREAS };
    }

    if (texto === '7' || texto.includes('mejora') || texto.includes('error') || texto.includes('fallo') || texto.includes('sugerencia')) {
      await guardarSesion(telefono, 'menu_feedback', null);
      return { texto: MENU_FEEDBACK };
    }

    await guardarSesion(telefono, 'menu', null);
    return { texto: MENSAJE_MENU };
  }

  // ------------------------------------------------------------
  // Paso: submenú "Mis Datos"
  // ------------------------------------------------------------
  if (sesion.estado === 'menu_mis_datos') {
    const { comercial_id: comercialId, odoo_user_id: odooUserId } = sesion.contexto;

    if (texto === 'menu' || texto === 'menú') {
      await guardarSesion(telefono, 'menu', null);
      return { texto: MENSAJE_MENU };
    }

    try {
      if (texto === '1') {
        const resultado = await obtenerVentasTodosPeriodos(getEmpresaActiva(), comercialId);
        return { texto: `${formatearVentasTodosPeriodos(resultado)}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '2') {
        const lista = await obtenerTopClientes(getEmpresaActiva(), comercialId, 'mes');
        return { texto: `${formatearTopClientes('mes', lista)}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '3') {
        const lista = await obtenerTopArticulos(getEmpresaActiva(), comercialId, 'mes');
        return { texto: `${formatearTopArticulos('mes', lista)}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '4') {
        const resultado = await getMiDiaComercial(odooUserId);
        return { texto: `${formatearMiDia(resultado)}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '5') {
        const resultado = await obtenerMisObjetivos(getEmpresaActiva(), comercialId);
        return { texto: `${formatearObjetivos(resultado)}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '6') {
        const resultado = await obtenerPendientesCobro(getEmpresaActiva(), comercialId);
        return { texto: `${formatearPendientesCobro(resultado)}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '7') {
        const lista = await obtenerClientesInactivos(getEmpresaActiva(), comercialId);
        return { texto: `${formatearClientesInactivos(lista)}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '8') {
        const lista = await getFaltasComercial(odooUserId);
        return { texto: `${formatearFaltas(lista)}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '9') {
        const texto2 = await resumenGlobalComercial(odooUserId);
        return { texto: `${texto2}\n\n${MENU_MIS_DATOS}` };
      }
      if (texto === '10') {
        const { texto: texto3, entregas } = await listarEntregadosSemanaComercial(odooUserId);
        if (entregas.length === 0) {
          return { texto: `${texto3}\n\n${MENU_MIS_DATOS}` };
        }
        await guardarSesion(telefono, 'esperando_seleccion_entrega_semana', { odoo_user_id: odooUserId, comercial_id: comercialId, entregas });
        return { texto: texto3 };
      }
    } catch (err) {
      console.error('Error en Mis Datos:', err);
      return { texto: `⚠️ No he podido calcular ese dato ahora mismo. Inténtalo de nuevo en un momento.\n\n${MENU_MIS_DATOS}` };
    }

    return { texto: MENU_MIS_DATOS };
  }

  // ------------------------------------------------------------
  // MIS DATOS — elegir una entrega concreta (de la lista de la semana)
  // para ver sus fotos completas
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_seleccion_entrega_semana') {
    if (texto === 'menu' || texto === 'menú') {
      await guardarSesion(telefono, 'menu', null);
      return { texto: MENSAJE_MENU };
    }
    const indice = parseInt(textoOriginal, 10) - 1;
    const { entregas, odoo_user_id: odooUserId, comercial_id: comercialId } = sesion.contexto || {};
    if (isNaN(indice) || !entregas?.[indice]) {
      return { texto: `Responde con un número entre 1 y ${entregas?.length || 0}, o escribe *menu* para volver al principio.` };
    }
    const elegida = entregas[indice];
    const orderId = Array.isArray(elegida.sale_id) ? elegida.sale_id[0] : elegida.sale_id;
    const refPedido = Array.isArray(elegida.sale_id) ? elegida.sale_id[1] : elegida.name;
    const texto2 = await detallePedido(orderId, refPedido);
    await guardarSesion(telefono, 'menu_mis_datos', { odoo_user_id: odooUserId, comercial_id: comercialId });
    return { texto: `${texto2}\n\n${MENU_MIS_DATOS}` };
  }

  // ------------------------------------------------------------
  // Paso: esperando el nombre del producto (STOCK)
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_producto') {
    if (textoOriginal.length < 2) {
      return { texto: 'Escribe al menos 2 letras del nombre del producto.' };
    }

    const candidatos = await buscarProductos(textoOriginal);

    if (candidatos.length === 0) {
      return { texto: `No he encontrado ningún producto con "${textoOriginal}". Prueba con otra palabra, o escribe *menu* para volver al principio.` };
    }

    if (candidatos.length === 1) {
      return responderStock(telefono, candidatos[0], comercial);
    }

    // Stock de cada candidato en UNA consulta a Odoo, para que el comercial
    // vaya directo al que tenemos en almacén. Los que tienen stock salen
    // primero. Si la consulta falla, la lista sale igual, sin stock.
    let lista = candidatos.slice(0, MAX_CANDIDATOS);
    let stockPorId = null;
    try {
      const filas = await getStockDisponible(lista.map((p) => p.id));
      stockPorId = Object.fromEntries(filas.map((f) => [f.id, f.qty_available || 0]));
      lista = lista
        .map((p, i) => ({ p, i, hay: (stockPorId[p.id] || 0) > 0 }))
        .sort((a, b) => (Number(b.hay) - Number(a.hay)) || (a.i - b.i))
        .map((x) => x.p);
    } catch (err) {
      console.error('[Stock] No se pudo leer el stock de los candidatos (la lista sale sin stock):', err.message);
    }
    const lineaStock = (p) => {
      if (!stockPorId) return '';
      const q = Math.round((stockPorId[p.id] || 0) * 100) / 100;
      return q > 0 ? `\n    ✅ ${q.toLocaleString('es-ES')} uds` : '\n    ❌ sin stock';
    };
    const textoLista = lista.map((p, i) => `${i + 1}. ${p.nombre}${p.ref ? ` (${p.ref})` : ''}${lineaStock(p)}`).join('\n');
    const hayMas = candidatos.length > MAX_CANDIDATOS
      ? '\n\n🔎 Hay más resultados. Si no ves el tuyo, escribe *menu* → *1* y busca con otra palabra más (ej. "hamburguesa angus 180").'
      : '';
    await guardarSesion(telefono, 'esperando_seleccion', { candidatos: lista });
    return { texto: `He encontrado varios productos, ¿cuál quieres consultar?\n\n${textoLista}${hayMas}\n\nResponde con el número.` };
  }

  // ------------------------------------------------------------
  // "r" tras STOCK: esperando el precio para el mensaje al cliente
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_precio_cliente') {
    const p = sesion.contexto?.producto;
    if (!p) {
      await guardarSesion(telefono, 'menu', null);
      return { texto: MENSAJE_MENU };
    }
    let precio;
    if ((texto === 'm' || texto === 'media') && !esConsulta(comercial) && p.precio_medio != null) {
      precio = Math.round(p.precio_medio * 100) / 100;
    } else if (texto === '0' || texto === 'sin precio' || texto === 'no') {
      precio = null;
    } else {
      precio = leerPrecio(textoOriginal);
      if (precio == null || precio <= 0) {
        return { texto: 'No entiendo el precio. Escribe solo el número (ej. *11,90*), *m* para la venta media, *0* para no poner precio, o *menu* para salir.' };
      }
    }

    await guardarSesion(telefono, 'menu', { ultimo_producto: p });

    // 1) El texto para el cliente, solo, para reenviarlo tal cual
    await enviarMensajeLibre({ to: telefono, body: textoParaClienteStock(p, precio) });

    // 2) La ficha técnica, si hay (el pie del PDF también va al cliente)
    let fichaOk = false;
    if (p.hay_ficha) {
      try {
        const mediaUrl = await urlFichaPrincipal(p.id);
        if (mediaUrl) {
          await enviarMensajeLibre({ to: telefono, body: `📑 Ficha técnica — ${p.nombre}`, mediaUrl });
          fichaOk = true;
        }
      } catch (err) {
        console.error('[r stock] No se pudo adjuntar la ficha técnica:', err.message);
      }
    }

    const fallo = p.hay_ficha && !fichaOk ? '\n⚠️ No he podido adjuntar la ficha técnica; pídela con *ficha*.' : '';
    return {
      texto: `☝️ Reenvía al cliente ${fichaOk ? 'los dos mensajes de arriba (texto y ficha)' : 'el mensaje de arriba'}: mantenlos pulsados y dale a reenviar.${fallo}\n\nEscribe *menu* para otra consulta.`,
    };
  }

  // ------------------------------------------------------------
  // Paso: esperando que elija producto de la lista (STOCK)
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_seleccion') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const candidatos = sesion.contexto?.candidatos || [];

    if (isNaN(indice) || !candidatos[indice]) {
      return { texto: `Responde con un número entre 1 y ${candidatos.length}, o escribe *menu* para volver al principio.` };
    }

    return responderStock(telefono, candidatos[indice], comercial);
  }

  // ------------------------------------------------------------
  // FICHA TÉCNICA: esperando el nombre del producto
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_producto_ficha') {
    return buscarYResponderFicha(telefono, textoOriginal, !!sesion.contexto?.todas);
  }

  // FICHA TÉCNICA: elegir producto de la lista
  if (sesion.estado === 'esperando_seleccion_ficha') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const candidatos = sesion.contexto?.candidatos || [];
    if (isNaN(indice) || !candidatos[indice]) {
      return { texto: `Responde con un número entre 1 y ${candidatos.length}, o escribe *menu* para volver al principio.` };
    }
    return responderFicha(telefono, candidatos[indice], !!sesion.contexto?.todas);
  }

  // FICHA TÉCNICA: el artículo tiene varios PDF, elegir cuál
  if (sesion.estado === 'esperando_adjunto_ficha') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const { producto, adjuntos = [] } = sesion.contexto || {};
    if (isNaN(indice) || !adjuntos[indice] || !producto) {
      return { texto: `Responde con un número entre 1 y ${adjuntos.length}, o escribe *menu* para volver al principio.` };
    }
    await guardarSesion(telefono, 'menu', { ultimo_producto: producto });
    return enviarAdjunto(producto, adjuntos[indice]);
  }

  // ------------------------------------------------------------
  // Paso: esperando que elija catálogo de la lista
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_catalogo') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const catalogos = sesion.contexto?.catalogos || [];

    if (isNaN(indice) || !catalogos[indice]) {
      return { texto: `Responde con un número entre 1 y ${catalogos.length}, o escribe *menu* para volver al principio.` };
    }

    const elegido = catalogos[indice];
    await guardarSesion(telefono, 'esperando_catalogo', { catalogos });
    return respuestaCatalogo(elegido, '¿Necesitas otro? Responde con el número, o escribe *menu* para salir.');
  }

  // ------------------------------------------------------------
  // Paso: esperando el nombre del cliente (FACTURAS)
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_cliente') {
    if (textoOriginal.length < 2) {
      return { texto: 'Escribe al menos 2 letras del nombre del cliente.' };
    }

    const aliasEncontrados = await buscarAliasCliente(telefono, textoOriginal);
    if (aliasEncontrados.length === 1) {
      return await entrarMenuCliente(telefono, aliasEncontrados[0].cliente_id, aliasEncontrados[0].cliente_nombre, sesion.contexto?.destino);
    }

    const odooUserId = sesion.contexto?.odoo_user_id;
    const clientes = await buscarClientesComercial(odooUserId, textoOriginal, comercial.ve_todos_clientes);

    if (clientes.length === 0 && aliasEncontrados.length === 0) {
      return { texto: `No he encontrado ningún ${comercial.ve_todos_clientes ? '' : 'cliente tuyo'}${comercial.ve_todos_clientes ? 'cliente' : ''} con "${textoOriginal}". Prueba con otra palabra (razón social, nombre del local o CIF), o escribe *menu* para volver al principio.` };
    }

    if (clientes.length === 1 && aliasEncontrados.length === 0) {
      return await entrarMenuCliente(telefono, clientes[0].id, clientes[0].name, sesion.contexto?.destino);
    }

    // Combina alias propios (primero) con resultados de Odoo, sin duplicar cliente_id
    const vistos = new Set(aliasEncontrados.map((a) => a.cliente_id));
    const lista = [
      ...aliasEncontrados.map((a) => ({ id: a.cliente_id, name: `${a.cliente_nombre} (alias: ${a.alias})` })),
      ...clientes.filter((c) => !vistos.has(c.id)),
    ].slice(0, MAX_CANDIDATOS);
    const textoLista = lista.map((c, i) => `${i + 1}. ${c.etiqueta || c.name}`).join('\n');
    await guardarSesion(telefono, 'esperando_seleccion_cliente', { candidatos: lista, destino: sesion.contexto?.destino || null });
    return { texto: `He encontrado varios clientes${comercial.ve_todos_clientes ? '' : ' tuyos'}, ¿cuál quieres consultar?\n\n${textoLista}\n\nResponde con el número.` };
  }

  // ------------------------------------------------------------
  // Paso: esperando que elija cliente de la lista (CLIENTE)
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_seleccion_cliente') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const candidatos = sesion.contexto?.candidatos || [];

    if (isNaN(indice) || !candidatos[indice]) {
      return { texto: `Responde con un número entre 1 y ${candidatos.length}, o escribe *menu* para volver al principio.` };
    }

    const elegido = candidatos[indice];
    return await entrarMenuCliente(telefono, elegido.id, elegido.name, sesion.contexto?.destino);
  }

  // ------------------------------------------------------------
  // CLIENTE — mini-menú tras elegir cliente: facturas/estudio/pedido/
  // seguimiento, todo sin tener que volver a buscarlo.
  // ------------------------------------------------------------
  if (sesion.estado === 'menu_cliente') {
    const { clienteId, clienteNombre } = sesion.contexto || {};
    if (!clienteId) {
      await guardarSesion(telefono, 'menu', null);
      return { texto: MENSAJE_MENU };
    }

    if (textoOriginal === '1') {
      await guardarSesion(telefono, 'menu_facturas', { clienteId, clienteNombre });
      return { texto: MENU_FACTURAS(clienteNombre) };
    }
    if (textoOriginal === '2') {
      const textoEstudio = await generarEstudioParaCliente(clienteId, clienteNombre);
      await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
      return { texto: `${textoEstudio}\n\n1 Facturas · 3 Pedido · 4 Seguimiento · 5 Consumo · *menu* salir` };
    }
    if (textoOriginal === '3') {
      return await iniciarSeleccionDireccion(telefono, clienteId, clienteNombre);
    }
    if (textoOriginal === '4') {
      await guardarSesion(telefono, 'menu_seguimiento', { clienteId, clienteNombre });
      return { texto: MENU_SEGUIMIENTO(clienteNombre) };
    }
    if (textoOriginal === '5') {
      await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
      try {
        const consumo = await generarConsumoCliente(clienteId, clienteNombre);
        return { texto: `${consumo.texto}\n\n1 Facturas · 2 Estudio · 3 Pedido · 4 Seguimiento · *menu* salir`, mediaUrl: consumo.mediaUrl };
      } catch (err) {
        console.error('Error generando consumo del cliente:', err);
        return { texto: `⚠️ No he podido preparar el consumo ahora mismo. Inténtalo de nuevo en un momento.\n\n${MENU_CLIENTE(clienteNombre)}` };
      }
    }
    if (textoOriginal === '6') {
      return prepararFichasCliente(telefono, clienteId, clienteNombre);
    }
    if (textoOriginal === '8') {
      await guardarSesion(telefono, 'esperando_carta', { clienteId, clienteNombre });
      return { texto: `📖 *Estudio de carta — ${clienteNombre}*\n\nMándame la carta del restaurante:\n• el *enlace* de su web,\n• el *PDF*, o\n• una o varias *fotos* (de una en una).\n\nTe preparo qué productos nuestros encajan con sus platos y cuáles no nos compra. O escribe *menu* para salir.\n\n¿Un local que aún no es cliente? Escribe *carta nueva* y su nombre.` };
    }
    if (textoOriginal === '10') {
      await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
      try {
        const { url, token } = await crearEnlace360({ empresa: getEmpresaActiva(), clienteId, clienteNombre, comercial, modo: 'ligero' });
        // Si acaba de reenviar un pedido, va ya cargado en el enlace
        const cargados = await asignarPedidosRecibidos({ empresa: getEmpresaActiva(), telefono: comercial.telefono, token }).catch(() => 0);
        if (cargados) {
          return {
            texto: `🧾 *Pedido de ${clienteNombre}*\n\nEl pedido que me has reenviado ya está cargado. Ábrelo y pulsa *Interpretar pedido*:\n${url}\n\nVale ${DIAS_INFORME_360} días.\n\n1 Facturas · 3 Pedido · 7 Informe 360 · *menu* salir`,
          };
        }
        return {
          texto: `🧾 *Pedido y carta en la web — ${clienteNombre}*\n\nSe abre al momento (sin preparar el informe): pedido con texto o foto a la izquierda y lo interpretado a la derecha, y el estudio de su carta.\n${url}\n\nVale ${DIAS_INFORME_360} días.\n\n1 Facturas · 3 Pedido · 7 Informe 360 · *menu* salir`,
        };
      } catch (err) {
        console.error('Error creando el enlace de pedido web:', err);
        return { texto: `⚠️ No he podido preparar el enlace ahora mismo. Inténtalo de nuevo en un momento.\n\n${MENU_CLIENTE(clienteNombre)}` };
      }
    }
    if (textoOriginal === '9') {
      await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
      try {
        const { token } = await crearEnlace360({ empresa: getEmpresaActiva(), clienteId, clienteNombre, comercial });
        return {
          texto: `🗂️ *Catálogo a medida — ${clienteNombre}*\n\nElige los artículos por etiquetas (familia, alérgenos, preparación…) y se lo mandas por WhatsApp con fotos y sus precios:\n${process.env.SITE_URL}/catalogo-elegir.html?t=${token}\n\nCuando lo abra o marque algo, te aviso por aquí. El enlace vale ${DIAS_INFORME_360} días.\n\n1 Facturas · 3 Pedido · 7 Informe 360 · *menu* salir`,
        };
      } catch (err) {
        console.error('Error creando el enlace del catálogo a medida:', err);
        return { texto: `⚠️ No he podido preparar el catálogo ahora mismo. Inténtalo de nuevo en un momento.\n\n${MENU_CLIENTE(clienteNombre)}` };
      }
    }
    if (textoOriginal === '7') {
      await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
      try {
        const { url } = await crearEnlace360({ empresa: getEmpresaActiva(), clienteId, clienteNombre, comercial });
        return {
          texto: `📊 *Informe 360 — ${clienteNombre}*\n\nÁbrelo en la tablet o el ordenador para verlo mejor:\n${url}\n\nEl enlace es personal y vale ${DIAS_INFORME_360} días.\n\n1 Facturas · 2 Estudio · 3 Pedido · 4 Seguimiento · *menu* salir`,
        };
      } catch (err) {
        console.error('Error creando el enlace del Informe 360:', err);
        return { texto: `⚠️ No he podido preparar el informe ahora mismo. Inténtalo de nuevo en un momento.\n\n${MENU_CLIENTE(clienteNombre)}` };
      }
    }

    return { texto: MENU_CLIENTE(clienteNombre) };
  }

  // ------------------------------------------------------------
  // ESTUDIO DE CARTA: esperando el enlace, el PDF o la foto de la carta
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_foto_perfil') {
    if (!media || !(media.contentType || '').startsWith('image/')) return { texto: 'Mándame la foto (como imagen), o escribe *menu* para salir.' };
    try {
      const { descargarMediaTwilio } = require('./galeria');
      const { buffer, contentType } = await descargarMediaTwilio(media.url);
      const ruta = `perfiles/${getEmpresaActiva()}/${soloDigitos(telefono).slice(-9)}.jpg`;
      const { error } = await supabase.storage.from('facturas').upload(ruta, buffer, { contentType, upsert: true });
      if (error) throw error;
      const url = `${supabase.storage.from('facturas').getPublicUrl(ruta).data.publicUrl}?v=${Date.now()}`;
      await supabase.from('comerciales').update({ foto_url: url }).eq('empresa', getEmpresaActiva()).eq('telefono', comercial.telefono);
      await guardarSesion(telefono, 'menu');
      return { texto: '✅ Foto guardada. Saldrá en tus páginas y tarjetas de primer contacto. Si quieres cambiarla, escribe *mi foto* otra vez.' };
    } catch (err) {
      console.error('Error guardando la foto del comercial:', err);
      return { texto: '⚠️ No he podido guardar la foto. Inténtalo de nuevo, o escribe *menu*.' };
    }
  }

  if (sesion.estado === 'esperando_local_permiso') {
    const { candidatos = [], nombre, movil } = sesion.contexto || {};
    const l = candidatos[Number(textoOriginal) - 1];
    if (!l) return { texto: 'Responde con el número del local, o *menu* para salir.' };
    await guardarSesion(telefono, 'esperando_via_permiso', { place_id: l.place_id, local: l.nombre, municipio: l.municipio, nombre, movil });
    return { texto: preguntaViaPermiso(l.nombre, nombre, movil) };
  }
  if (sesion.estado === 'esperando_via_permiso') {
    const ctx = sesion.contexto || {};
    const via = textoOriginal === '1' ? 'telefono' : textoOriginal === '2' ? 'persona' : null;
    if (!via) return { texto: 'Responde *1* (por teléfono) o *2* (en persona), o *menu* para salir.' };
    try {
      await require('./primerContacto').registrarPermiso({ empresa: getEmpresaActiva(), placeId: ctx.place_id, localNombre: ctx.local, nombre: ctx.nombre, telefono: ctx.movil, via, por: comercial.nombre });
    } catch (e) {
      await guardarSesion(telefono, 'menu');
      return { texto: `⚠️ ${e.message} Vuelve a escribir *permiso* con el local, el nombre y el móvil.` };
    }
    await guardarSesion(telefono, 'esperando_envio_permiso', ctx);
    const hora = new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' });
    return { texto: `Apuntado: permiso ${via === 'telefono' ? 'por teléfono' : 'en persona'}, hoy a las ${hora}, por ${comercial.nombre || 'ti'}.\n\n¿Le envío ya su propuesta?\n1 Sí, envíala\n2 Todavía no` };
  }
  if (sesion.estado === 'esperando_envio_permiso') {
    const ctx = sesion.contexto || {};
    await guardarSesion(telefono, 'menu');
    if (textoOriginal !== '1') return { texto: 'Vale, no la envío. Puedes hacerlo cuando quieras desde la web de prospección (Primer contacto) o escribiendo otra vez *permiso*.' };
    try {
      const PC = require('./primerContacto');
      const { data: pag } = await supabase.from('contacto_locales').select('id').eq('empresa', getEmpresaActiva()).eq('place_id', ctx.place_id).maybeSingle();
      if (pag) {
        const r = await PC.enviarPropuesta({ empresa: getEmpresaActiva(), comercial_nombre: comercial.nombre }, ctx.place_id);
        return { texto: `✅ Enviada a ${r.enviado_a}. Te aviso cuando abra su página o pida visita.` };
      }
      // Aún no tiene página: se prepara (IA) y se envía en segundo plano
      const enlace = await crearEnlace360({ empresa: getEmpresaActiva(), clienteId: null, clienteNombre: ctx.municipio || ctx.local, comercial, modo: 'prospeccion' });
      await crearTrabajo({ token: enlace.token }, 'primer_contacto', { place_id: ctx.place_id, enviar: true, avisar_whatsapp: telefono });
      return { texto: `Preparando la página de *${ctx.local}* y enviándosela… te aviso en un momento.` };
    } catch (e) {
      return { texto: `⚠️ No se ha podido enviar: ${e.message}` };
    }
  }

  if (sesion.estado === 'esperando_grupo_prospeccion') {
    const { municipio, grupos = [] } = sesion.contexto || {};
    const g = grupos[Number(textoOriginal) - 1];
    if (!g) return { texto: `Responde con el número (${grupos.map((x, i) => `${i + 1} ${x.nombre}`).join(' · ')}), o *menu* para salir.` };
    return lanzarProspeccion(telefono, comercial, municipio, g.clave);
  }

  if (sesion.estado === 'esperando_carta') {
    const { clienteId, clienteNombre, prospecto } = sesion.contexto || {};
    const nombreLocal = prospecto || clienteNombre;
    const url = (textoOriginal.match(/https?:\/\/\S+|(?:www\.)\S+\.\S+/i) || [])[0];
    const esArchivo = media && ((media.contentType || '').startsWith('image/') || (media.contentType || '').includes('pdf'));
    if (!esArchivo && !url) {
      return { texto: 'Mándame el enlace de la carta, el PDF o una foto. O escribe *menu* para salir.' };
    }
    try {
      // Sin preparar el Informe 360: enlace ligero (cliente) o de prospecto (aún no es cliente)
      const enlace = prospecto
        ? await crearEnlace360({ empresa: getEmpresaActiva(), clienteId: null, clienteNombre: prospecto, comercial, modo: 'prospecto' })
        : await crearEnlace360({ empresa: getEmpresaActiva(), clienteId, clienteNombre, comercial, modo: 'ligero' });
      const payload = esArchivo
        ? { tipo: 'twilio', media_url: media.url, avisar_whatsapp: telefono }
        : { tipo: 'enlace', url, avisar_whatsapp: telefono };
      await crearTrabajo({ token: enlace.token }, 'carta', payload);
      if (prospecto) await guardarSesion(telefono, 'menu');
      else await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
      return { texto: `📖 Estudiando la carta de *${nombreLocal}*… tarda entre 1 y 3 minutos. Te aviso por aquí cuando esté.\n\nEl estudio saldrá aquí:\n${enlace.url}#carta\n\nAhí verás nuestro coste de cada artículo, le pones el precio (en rojo si baja del 30 % de margen) y sacas la propuesta en PDF para dársela.${prospecto ? '' : ''}\n\nSi la carta tiene más fotos, mándalas después como estudio nuevo.` };
    } catch (err) {
      console.error('Error lanzando el estudio de carta:', err);
      return { texto: '⚠️ No he podido empezar el estudio ahora mismo. Inténtalo de nuevo en un momento, o escribe *menu*.' };
    }
  }

  // ------------------------------------------------------------
  // FICHAS TÉCNICAS DEL CLIENTE: elegir un PDF con todas o una a una
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_modo_fichas_cliente') {
    const { clienteId, clienteNombre, items = [] } = sesion.contexto || {};
    const modo = textoOriginal === '1' ? 'pdf' : textoOriginal === '2' ? 'una' : null;
    if (!modo || !items.length) {
      return { texto: 'Responde *1* (un PDF con todas) o *2* (una a una), o escribe *menu* para volver al principio.' };
    }
    if (modo === 'una' && items.length > MAX_FICHAS_UNA_A_UNA) {
      return { texto: `Son ${items.length} fichas: una a una serían demasiados mensajes. Responde *1* para recibirlas en un PDF.` };
    }
    await guardarSesion(telefono, 'menu_cliente', { clienteId, clienteNombre });
    try {
      await fetch(`${SITE_URL}/.netlify/functions/enviar-fichas-cliente-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefono, empresa: getEmpresaActiva(), clienteNombre, modo, items }),
      });
    } catch (err) {
      console.error('Error lanzando enviar-fichas-cliente-background:', err);
      return { texto: `⚠️ No he podido empezar a preparar las fichas. Inténtalo de nuevo en un momento.\n\n${MENU_CLIENTE(clienteNombre)}` };
    }
    const espera = modo === 'pdf'
      ? `⏳ Estoy juntando las ${items.length} fichas en un PDF. Te llega en uno o dos minutos, listo para reenviar.`
      : `⏳ Te mando las ${items.length} fichas, una por mensaje. Tardarán un par de minutos en llegar todas.`;
    return { texto: `${espera}\n\n${MENU_CLIENTE(clienteNombre)}` };
  }

  // ------------------------------------------------------------
  // Paso: tras ver facturas pendientes, ofrecer el texto listo para
  // reenviar tal cual al cliente
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_reenvio_facturas') {
    const { clienteNombre, facturas } = sesion.contexto || {};

    if (texto === 'reenviar' || texto === 'r') {
      const textoParaCliente = facturas ? formatearListaPendientesParaCliente(facturas) : null;
      if (!textoParaCliente) {
        return { texto: `✅ *${clienteNombre}* no tiene facturas pendientes de pago.\n\nEscribe *menu* para otra consulta.` };
      }
      await guardarSesion(telefono, 'menu', null);

      // El texto para el cliente puede pasar del límite de WhatsApp
      // (1600 caracteres) con muchas facturas: antes se cortaba con "…".
      // Ahora se manda en varios mensajes, cortando siempre entre líneas,
      // para poder reenviarlos todos tal cual.
      const partes = [];
      let actual = '';
      for (const linea of textoParaCliente.split('\n')) {
        if (actual && (actual.length + linea.length + 1) > 1400) { partes.push(actual); actual = ''; }
        actual = actual ? `${actual}\n${linea}` : linea;
      }
      if (actual) partes.push(actual);
      for (const parte of partes) {
        try {
          await enviarMensajeLibre({ to: telefono, body: parte });
        } catch (err) {
          console.error('Error mandando el texto de pendientes para reenviar:', err);
        }
      }

      // PDF de exactamente las facturas del texto (normales y
      // rectificativas), en segundo plano y en mensajes aparte.
      const idsPendientes = facturas.filter((f) => PENDIENTES.includes(f.payment_state)).map((f) => f.id);
      try {
        await fetch(`${SITE_URL}/.netlify/functions/enviar-factura-background`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ telefono, moveId: idsPendientes, clienteNombre, empresa: getEmpresaActiva(), paraCliente: true }),
        });
      } catch (err) {
        console.error('Error lanzando el PDF de pendientes para reenviar:', err);
      }

      const variosMensajes = partes.length > 1 ? `☝️ Son muchas facturas: te lo he mandado en ${partes.length} mensajes, reenvíalos todos.\n` : '';
      const variosPdf = idsPendientes.length > 10 ? ` (en ${Math.ceil(idsPendientes.length / 10)} PDF de 10 facturas)` : '';
      return { texto: `${variosMensajes}📄 El PDF con esas facturas te llega en un momento${variosPdf}, para reenviárselo también.\n\nEscribe *menu* para otra consulta.` };
    }

    await guardarSesion(telefono, 'menu', null);
    return { texto: MENSAJE_MENU };
  }

  // ------------------------------------------------------------
  // Paso: submenú de facturas de un cliente ya identificado
  // ------------------------------------------------------------
  if (sesion.estado === 'menu_facturas') {
    const { clienteId, clienteNombre } = sesion.contexto || {};
    if (!clienteId) {
      await guardarSesion(telefono, 'menu', null);
      return { texto: MENSAJE_MENU };
    }

    if (texto.startsWith('alias ')) {
      const alias = textoOriginal.slice(6).trim();
      if (alias.length < 2) {
        return { texto: 'Escribe "alias <nombre>", con al menos 2 letras, ej. "alias gansa".' };
      }
      try {
        await guardarAliasComercial(telefono, alias, clienteId, clienteNombre);
        return { texto: `✅ Guardado. A partir de ahora, escribe "${alias}" para localizar directamente a *${clienteNombre}*.\n\n${MENU_FACTURAS(clienteNombre)}` };
      } catch (err) {
        console.error('Error guardando alias:', err);
        return { texto: '⚠️ No he podido guardar el alias ahora mismo. Inténtalo de nuevo.' };
      }
    }

    if (!['1', '2', '3', '4', '5', '6'].includes(textoOriginal)) {
      return { texto: MENU_FACTURAS(clienteNombre) };
    }

    // Opción 6: todas las facturas de un trimestre (las pide el cliente
    // porque las ha perdido o para su gestoría). No necesita la lista
    // general de facturas: se consulta el trimestre elegido aparte.
    if (textoOriginal === '6') {
      await guardarSesion(telefono, 'esperando_trimestre_facturas', { clienteId, clienteNombre });
      return { texto: menuTrimestres(clienteNombre) };
    }

    const facturas = await getFacturasCliente(clienteId);

    if (textoOriginal === '2') {
      await guardarSesion(telefono, 'esperando_reenvio_facturas', { clienteId, clienteNombre, facturas });
      const textoParaCliente = formatearListaPendientesParaCliente(facturas);
      const pie = textoParaCliente
        ? '\n\nEscribe *r* para tener el texto listo para copiar y mandarle al cliente, o *menu* para otra consulta.'
        : '\n\nEscribe *menu* para otra consulta.';
      return { texto: `${formatearListaPendientes(clienteNombre, facturas)}${pie}` };
    }

    // El resto de opciones se quedan en este mismo submenú (no se
    // vuelve al principio) — así el comercial puede pedir otra cosa
    // del mismo cliente sin tener que volver a buscarlo.
    await guardarSesion(telefono, 'menu_facturas', { clienteId, clienteNombre });

    if (textoOriginal === '1') return { texto: `${formatearResumenCuenta(clienteNombre, facturas)}\n\n${MENU_FACTURAS(clienteNombre)}` };

    // Opción 5: informe corporativo en PDF — con clientes que tienen
    // muchas facturas, el PDF con todo el histórico se hace enorme, así
    // que primero se pregunta el periodo antes de generarlo.
    if (textoOriginal === '5') {
      if (facturas.length === 0) {
        return { texto: `No hay facturas registradas para *${clienteNombre}*.\n\n${MENU_FACTURAS(clienteNombre)}` };
      }
      await guardarSesion(telefono, 'esperando_periodo_informe', { clienteId, clienteNombre, facturas });
      return { texto: `📊 *Informe de cuenta — ${clienteNombre}*\n\n¿Qué periodo quieres incluir?\n\n1️⃣ Último trimestre\n2️⃣ Año actual\n3️⃣ Todas las facturas\n\nResponde con el número.` };
    }

    // Opción 3: última factura. Opción 4: todas las pendientes en un PDF
    // combinado. En ambos casos, generar el PDF (login web a Odoo +
    // informe + subida) tarda demasiado para hacerlo dentro de esta misma
    // respuesta, así que se dispara en segundo plano (Background Function)
    // y aquí solo se avisa de que está en camino.
    let moveIds;
    let textoBase;

    if (textoOriginal === '3') {
      textoBase = formatearUltimaFactura(clienteNombre, facturas);
      const soloFacturas = facturas.filter((f) => !f.rectificativa);
      if (soloFacturas.length === 0) {
        return { texto: `${textoBase}\n\n${MENU_FACTURAS(clienteNombre)}` };
      }
      moveIds = soloFacturas[0].id;
    } else {
      const pendientes = facturas.filter((f) => PENDIENTES.includes(f.payment_state));
      if (pendientes.length === 0) {
        return { texto: `✅ *${clienteNombre}* no tiene facturas pendientes de pago.\n\n${MENU_FACTURAS(clienteNombre)}` };
      }
      textoBase = formatearListaPendientes(clienteNombre, facturas);
      moveIds = pendientes.map((f) => f.id);
    }

    try {
      await fetch(`${SITE_URL}/.netlify/functions/enviar-factura-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefono, moveId: moveIds, clienteNombre, empresa: getEmpresaActiva() }),
      });
    } catch (err) {
      console.error('Error lanzando enviar-factura-background:', err);
    }

    return { texto: `${textoBase}\n\n📄 Te mando el PDF por WhatsApp en un momento.\n\n${MENU_FACTURAS(clienteNombre)}` };
  }

  // ------------------------------------------------------------
  // Paso: elegir trimestre para mandar todas sus facturas en PDF
  // (opción 6 de FACTURAS)
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_trimestre_facturas') {
    const { clienteId, clienteNombre } = sesion.contexto || {};
    if (!clienteId) {
      await guardarSesion(telefono, 'menu', null);
      return { texto: MENSAJE_MENU };
    }
    const trimestre = interpretarTrimestre(textoOriginal);
    if (!trimestre) {
      return { texto: `No te he entendido.\n\n${menuTrimestres(clienteNombre)}` };
    }

    await guardarSesion(telefono, 'menu_facturas', { clienteId, clienteNombre });

    let facturasTrim;
    try {
      facturasTrim = await getFacturasClientePeriodo(clienteId, trimestre.desde, trimestre.hasta);
    } catch (err) {
      console.error('Error buscando facturas del trimestre:', err);
      return { texto: `⚠️ No he podido consultar las facturas ahora mismo. Inténtalo de nuevo en unos minutos.\n\n${MENU_FACTURAS(clienteNombre)}` };
    }
    if (facturasTrim.length === 0) {
      return { texto: `No hay facturas de *${clienteNombre}* en el *${trimestre.nombre}*.\n\n${MENU_FACTURAS(clienteNombre)}` };
    }

    const total = facturasTrim.reduce((s, f) => s + (f.amount_total || 0), 0);
    const nFact = facturasTrim.filter((f) => !f.rectificativa).length;
    const nRect = facturasTrim.length - nFact;
    const TANDA_TRIMESTRE = 25;
    const partes = Math.ceil(facturasTrim.length / TANDA_TRIMESTRE);
    const detalle = `${nFact} ${nFact === 1 ? 'factura' : 'facturas'}`
      + (nRect ? ` y ${nRect} ${nRect === 1 ? 'abono' : 'abonos'}` : '')
      + ` · total ${formatEuro(total)}`;

    try {
      await fetch(`${SITE_URL}/.netlify/functions/enviar-factura-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telefono,
          moveId: facturasTrim.map((f) => f.id),
          clienteNombre,
          empresa: getEmpresaActiva(),
          titulo: `Facturas del ${trimestre.nombre}`,
          tanda: TANDA_TRIMESTRE,
        }),
      });
    } catch (err) {
      console.error('Error lanzando enviar-factura-background (trimestre):', err);
    }

    const aviso = partes > 1 ? ` Son muchas, así que te llegarán en ${partes} PDF.` : '';
    return { texto: `🧾 *${clienteNombre}* — ${trimestre.nombre}\n${detalle}\n\n📄 Te mando el PDF por WhatsApp en un momento.${aviso}\n\n${MENU_FACTURAS(clienteNombre)}` };
  }

  // ------------------------------------------------------------
  // Paso: elegir periodo para el informe de cuenta (opción 5 de FACTURAS)
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_periodo_informe') {
    const { clienteId, clienteNombre, facturas } = sesion.contexto || {};
    if (!clienteId) {
      await guardarSesion(telefono, 'menu', null);
      return { texto: MENSAJE_MENU };
    }
    if (!['1', '2', '3'].includes(textoOriginal)) {
      return { texto: `Responde con 1, 2 o 3.\n\n1️⃣ Último trimestre\n2️⃣ Año actual\n3️⃣ Todas las facturas` };
    }

    let facturasFiltradas = facturas;
    let nombrePeriodo = 'Todas las facturas';
    if (textoOriginal === '1' || textoOriginal === '2') {
      const tipo = textoOriginal === '1' ? 'trimestre' : 'año';
      const { desde } = rangoActual(tipo);
      const desdeStr = desde.toISOString().slice(0, 10);
      facturasFiltradas = facturas.filter((f) => f.invoice_date && f.invoice_date >= desdeStr);
      nombrePeriodo = tipo === 'trimestre' ? 'Último trimestre' : 'Año actual';
    }

    await guardarSesion(telefono, 'menu_facturas', { clienteId, clienteNombre });

    if (facturasFiltradas.length === 0) {
      return { texto: `No hay facturas de *${clienteNombre}* en ese periodo (${nombrePeriodo}).\n\n${MENU_FACTURAS(clienteNombre)}` };
    }

    try {
      const buffer = await generarInformeFacturasPdf(clienteNombre, facturasFiltradas, getEmpresaActiva());
      const mediaUrl = await subirPdfStorage(buffer, `informe-cuenta-${getEmpresaActiva()}-${clienteId}-${Date.now()}.pdf`);
      return {
        texto: `📊 Informe de cuenta de *${clienteNombre}* (${nombrePeriodo}) listo — puedes reenviárselo directamente.\n\n${MENU_FACTURAS(clienteNombre)}`,
        mediaUrl,
      };
    } catch (err) {
      console.error('Error generando informe de facturas por periodo:', err);
      return { texto: `⚠️ No he podido generar el informe ahora mismo. Inténtalo de nuevo en unos minutos.\n\n${MENU_FACTURAS(clienteNombre)}` };
    }
  }

  // ------------------------------------------------------------
  // Paso: mini-submenú VISUAL (catálogos + galería juntos)
  // ------------------------------------------------------------
  if (sesion.estado === 'menu_visual') {
    if (textoOriginal === '1' || texto.includes('catalog')) {
      const catalogos = await listarCatalogos();
      if (catalogos.length === 0) {
        await guardarSesion(telefono, 'menu', null);
        return { texto: 'De momento no hay catálogos disponibles. Escribe *menu* para volver al principio.' };
      }
      const textoLista = catalogos.map((c, i) => `${i + 1}. ${c.familia}`).join('\n');
      await guardarSesion(telefono, 'esperando_catalogo', { catalogos });
      return { texto: `¿Qué catálogo necesitas?\n\n${textoLista}\n\nResponde con el número.` };
    }
    if (textoOriginal === '2' || texto.includes('galeria') || texto.includes('galería')) {
      await guardarSesion(telefono, 'menu_galeria');
      return { texto: MENU_GALERIA };
    }
    return { texto: MENU_VISUAL };
  }

  // ------------------------------------------------------------
  // Paso: submenú de galería
  // ------------------------------------------------------------
  if (sesion.estado === 'menu_galeria') {
    if (textoOriginal === '1') {
      await guardarSesion(telefono, 'menu', null);
      return { texto: `📸 Aquí tienes la galería: ${SITE_URL}/galeria.html\n\nEscribe *menu* para otra consulta.` };
    }
    if (textoOriginal === '2') {
      await guardarSesion(telefono, 'esperando_categoria_foto');
      return { texto: '¿De qué evento, feria o cliente es la foto? Escribe una etiqueta corta (ej. "Feria Hostelco 2026").' };
    }
    return { texto: MENU_GALERIA };
  }

  // ------------------------------------------------------------
  // Paso: esperando la categoría antes de subir la foto
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_categoria_foto') {
    if (textoOriginal.length < 2) {
      return { texto: 'Escribe una etiqueta un poco más larga para la categoría.' };
    }
    await guardarSesion(telefono, 'esperando_foto', { categoria: textoOriginal });
    return { texto: `Vale, categoría *${textoOriginal}*. Ahora mándame la foto (o varias, una a una).` };
  }

  // ------------------------------------------------------------
  // Paso: esperando la foto en sí
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_foto') {
    if (!media) {
      return { texto: 'Todavía estoy esperando una foto — mándala como imagen, o escribe *menu* para cancelar.' };
    }
    try {
      await guardarFotoGaleria({
        mediaUrl: media.url,
        categoria: sesion.contexto.categoria,
        subidoPor: comercial.nombre,
        telefono,
      });
      return { texto: `✅ Foto guardada en *${sesion.contexto.categoria}*. Mándame otra de la misma categoría, o escribe *menu* para terminar.` };
    } catch (err) {
      console.error('Error guardando foto de galería:', err);
      return { texto: '⚠️ No he podido guardar la foto. Inténtalo de nuevo, o escribe *menu*.' };
    }
  }

  // ------------------------------------------------------------
  // PEDIDO — paso 1: nombre del cliente
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_cliente_pedido') {
    if (textoOriginal.length < 2) {
      return { texto: 'Escribe al menos 2 letras del nombre del cliente.' };
    }

    const aliasEncontrados = await buscarAliasCliente(telefono, textoOriginal);
    if (aliasEncontrados.length === 1) {
      return await iniciarSeleccionDireccion(telefono, aliasEncontrados[0].cliente_id, aliasEncontrados[0].cliente_nombre);
    }

    const odooUserId = sesion.contexto?.odoo_user_id;
    const clientes = await buscarClientesComercial(odooUserId, textoOriginal, comercial.ve_todos_clientes);

    if (clientes.length === 0 && aliasEncontrados.length === 0) {
      return { texto: `No he encontrado ningún cliente tuyo con "${textoOriginal}". Prueba con otro nombre, o escribe *menu* para volver al principio.\n\n¿Es un local que aún no es cliente? Escribe *carta nueva ${textoOriginal}* para estudiar su carta.` };
    }
    if (clientes.length === 1 && aliasEncontrados.length === 0) {
      return await iniciarSeleccionDireccion(telefono, clientes[0].id, clientes[0].name);
    }
    const vistos = new Set(aliasEncontrados.map((a) => a.cliente_id));
    const lista = [
      ...aliasEncontrados.map((a) => ({ id: a.cliente_id, name: `${a.cliente_nombre} (alias: ${a.alias})` })),
      ...clientes.filter((c) => !vistos.has(c.id)),
    ].slice(0, MAX_CANDIDATOS);
    const textoLista = lista.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    await guardarSesion(telefono, 'esperando_seleccion_cliente_pedido', { candidatos: lista });
    return { texto: `He encontrado varios clientes tuyos, ¿cuál quieres consultar?\n\n${textoLista}\n\nResponde con el número.` };
  }

  // ------------------------------------------------------------
  // PEDIDO — paso 1b: elegir cliente de la lista
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_seleccion_cliente_pedido') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const candidatos = sesion.contexto?.candidatos || [];
    if (isNaN(indice) || !candidatos[indice]) {
      return { texto: `Responde con un número entre 1 y ${candidatos.length}, o escribe *menu* para volver al principio.` };
    }
    const elegido = candidatos[indice];
    return await iniciarSeleccionDireccion(telefono, elegido.id, elegido.name);
  }

  // ------------------------------------------------------------
  // PEDIDO — paso 2: elegir dirección de entrega
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_direccion') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const direcciones = sesion.contexto?.direcciones || [];
    if (isNaN(indice) || !direcciones[indice]) {
      return { texto: `Responde con un número entre 1 y ${direcciones.length}, o escribe *menu* para volver al principio.` };
    }
    const { clienteId, clienteNombre } = sesion.contexto;
    await guardarSesion(telefono, 'esperando_metodo_pedido', { clienteId, clienteNombre, direccionId: direcciones[indice].id });
    return { texto: `Dirección: *${direcciones[indice].name}*.\n\n¿Cómo quieres meter el pedido?\n\n1️⃣ Escribirlo yo (texto libre)\n2️⃣ Pedido rápido — productos habituales con cantidades sugeridas\n\nO escribe *alias <nombre>* para guardarle un atajo a este cliente.` };
  }

  // ------------------------------------------------------------
  // PEDIDO — paso 2b: elegir método (texto libre o pedido rápido)
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_metodo_pedido') {
    const { clienteId, clienteNombre, direccionId } = sesion.contexto;

    if (texto.startsWith('alias ')) {
      const alias = textoOriginal.slice(6).trim();
      if (alias.length < 2) {
        return { texto: 'Escribe "alias <nombre>", con al menos 2 letras, ej. "alias gansa".' };
      }
      try {
        await guardarAliasComercial(telefono, alias, clienteId, clienteNombre);
        return { texto: `✅ Guardado. A partir de ahora, escribe "${alias}" para localizar directamente a *${clienteNombre}*.\n\n1️⃣ Escribirlo yo (texto libre)\n2️⃣ Pedido rápido` };
      } catch (err) {
        console.error('Error guardando alias:', err);
        return { texto: '⚠️ No he podido guardar el alias ahora mismo. Inténtalo de nuevo.' };
      }
    }

    if (textoOriginal === '1') {
      await guardarSesion(telefono, 'esperando_texto_pedido', { clienteId, clienteNombre, direccionId });
      return { texto: `Escribe ahora el pedido de *${clienteNombre}* (un producto por línea).` };
    }

    if (textoOriginal === '2') {
      const empresa = getEmpresaActiva();
      const enlace = `${SITE_URL}/pedido-rapido.html?tel=${encodeURIComponent(telefono)}&empresa=${encodeURIComponent(empresa)}&comercial=1&cliente_id=${clienteId}`;
      await guardarSesion(telefono, 'menu', null);
      return { texto: `🛒 Pedido rápido de *${clienteNombre}*:\n${enlace}\n\nAjusta cantidades y envíalo — se crea directamente como presupuesto en Odoo.\n\nEscribe *menu* para otra consulta.` };
    }

    return { texto: 'Responde con 1 (escribirlo yo) o 2 (pedido rápido), o *alias <nombre>* para guardar un atajo.' };
  }

  // ------------------------------------------------------------
  // PEDIDO — paso 3: texto libre del pedido -> interpretar
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_texto_pedido') {
    // Nota de voz: Claude no puede transcribir audio directamente, así
    // que de momento se pide que lo escriba.
    if (media && media.contentType && media.contentType.startsWith('audio/')) {
      return { texto: 'De momento no puedo escuchar notas de voz — escríbeme el pedido en texto, por favor.' };
    }

    if (texto.startsWith('alias ')) {
      const alias = textoOriginal.slice(6).trim();
      const { clienteId, clienteNombre } = sesion.contexto;
      if (alias.length < 2) {
        return { texto: 'Escribe "alias <nombre>", con al menos 2 letras, ej. "alias gansa".' };
      }
      try {
        await guardarAliasComercial(telefono, alias, clienteId, clienteNombre);
        return { texto: `✅ Guardado. A partir de ahora, escribe "${alias}" para localizar directamente a *${clienteNombre}*.\n\nEscribe ahora el pedido (un producto por línea).` };
      } catch (err) {
        console.error('Error guardando alias:', err);
        return { texto: '⚠️ No he podido guardar el alias ahora mismo. Inténtalo de nuevo, o sigue con el pedido.' };
      }
    }

    if (!media && textoOriginal.length < 3) {
      return { texto: 'Escribe el pedido con al menos un producto (o mándame una foto de la nota/albarán), o *alias <nombre>* para guardarle un atajo a este cliente.' };
    }

    const { clienteId, clienteNombre, direccionId } = sesion.contexto;
    await guardarSesion(telefono, 'procesando_pedido', { clienteId, clienteNombre, direccionId });

    try {
      await fetch(`${SITE_URL}/.netlify/functions/interpretar-pedido-background`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          telefono, empresa: getEmpresaActiva(), clienteId, clienteNombre, direccionId,
          textoPedido: textoOriginal, media,
        }),
      });
    } catch (err) {
      console.error('Error lanzando interpretar-pedido-background:', err);
    }

    return { texto: '🧠 Interpretando tu pedido, dame un momento...' };
  }

  // ------------------------------------------------------------
  // PEDIDO — paso 3b: interpretación en curso (segundo plano)
  // ------------------------------------------------------------
  if (sesion.estado === 'procesando_pedido') {
    return { texto: 'Todavía estoy interpretando tu pedido — escribe algo en unos segundos para ver el resultado, o *menu* para cancelar.' };
  }

  if (sesion.estado === 'buscando_direcciones') {
    return { texto: 'Todavía estoy buscando las direcciones de ese cliente — escribe algo en unos segundos para ver el resultado, o *menu* para cancelar.' };
  }

  // ------------------------------------------------------------
  // PEDIDO — paso 4: confirmar y crear el presupuesto en Odoo
  // ------------------------------------------------------------
  // ------------------------------------------------------------
  // Aviso al cliente — elegir contacto entre varios
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_eleccion_contacto_cliente') {
    const { empresa, clienteId, clienteNombre, comercial: comercialCtx, contactos, listaProductos, mensajeBase } = sesion.contexto;

    if (texto === 'no avisar') {
      await guardarSesion(telefono, 'menu', null);
      return { texto: `De acuerdo, no se avisa a ${clienteNombre}.\n\nEscribe *menu* para otra consulta.` };
    }

    const indice = parseInt(textoOriginal, 10) - 1;
    if (isNaN(indice) || !contactos[indice]) {
      return { texto: `Responde con un número entre 1 y ${contactos.length}, o *no avisar*.` };
    }

    try {
      const aviso = await elegirContactoYProgramar({
        empresa, clienteId, clienteNombre, comercial: comercialCtx, contacto: contactos[indice], listaProductos,
      });
      await guardarSesion(telefono, 'menu', null);
      return { texto: `📤 Voy a avisar a *${aviso.contacto.nombre}* de ${clienteNombre}. Se enviará en ${aviso.minutos} min salvo que escribas *no avisar*.\n\nEscribe *menu* para otra consulta.` };
    } catch (err) {
      console.error('Error programando aviso al cliente (contacto elegido):', err);
      await guardarSesion(telefono, 'menu', null);
      return { texto: `${mensajeBase}\n\n⚠️ No he podido programar el aviso al cliente. Escribe *menu* para otra consulta.` };
    }
  }

  // ------------------------------------------------------------
  // Aviso al cliente — dar de alta el contacto de Pedidos
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_alta_contacto_cliente') {
    const { empresa, clienteId, clienteNombre, comercial: comercialCtx, listaProductos, mensajeBase } = sesion.contexto;

    if (texto === 'no avisar') {
      await guardarSesion(telefono, 'menu', null);
      return { texto: `De acuerdo, no se avisa a ${clienteNombre}.\n\nEscribe *menu* para otra consulta.` };
    }

    const partes = textoOriginal.split('-').map((p) => p.trim());
    const telefonoContacto = (partes[1] || '').replace(/[^\d+]/g, '');
    const nombreContacto = partes[0];
    if (!nombreContacto || telefonoContacto.length < 9) {
      return { texto: 'Escribe el nombre y teléfono así: *Nombre - Teléfono*, ej. "María - 622334455", o *no avisar*.' };
    }

    try {
      const aviso = await crearContactoYProgramar({
        empresa, clienteId, clienteNombre, comercial: comercialCtx, nombre: nombreContacto, telefono: telefonoContacto, listaProductos,
      });
      await guardarSesion(telefono, 'menu', null);
      return { texto: `✅ Contacto guardado. Voy a avisar a *${aviso.contacto.nombre}* de ${clienteNombre}. Se enviará en ${aviso.minutos} min salvo que escribas *no avisar*.\n\nEscribe *menu* para otra consulta.` };
    } catch (err) {
      console.error('Error dando de alta contacto y programando aviso:', err);
      await guardarSesion(telefono, 'menu', null);
      return { texto: `${mensajeBase}\n\n⚠️ No he podido guardar el contacto ni programar el aviso. Escribe *menu* para otra consulta.` };
    }
  }

  if (sesion.estado === 'esperando_confirmacion_pedido') {
    const { clienteId, clienteNombre, direccionId, lineas } = sesion.contexto;

    // Comandos cortos (pro/cant/add/del) — se traducen a los nombres
    // completos que ya usa el resto de la lógica, sin duplicar nada.
    const ALIAS_CORTOS = [
      [/^pro\s+/i, 'producto '],
      [/^cant\s+/i, 'cambiar '],
      [/^add\s+/i, 'buscar '],
      [/^del\s+/i, 'quitar '],
    ];
    for (const [patron, canonico] of ALIAS_CORTOS) {
      if (patron.test(textoOriginal)) {
        textoOriginal = textoOriginal.replace(patron, canonico);
        break;
      }
    }
    const textoNorm = textoOriginal.toLowerCase();

    if (textoNorm.startsWith('producto ')) {
      const partes = textoOriginal.slice(9).trim().split(/\s+/);
      const indice = parseInt(partes[0], 10) - 1;
      const busqueda = partes.slice(1).join(' ');
      if (isNaN(indice) || !lineas[indice] || busqueda.length < 2) {
        return { texto: 'Escribe "producto <número de línea> <qué buscar>", ej. "producto 3 pan brioche 48".' };
      }
      const candidatos = await buscarEnCatalogoCliente(getEmpresaActiva(), clienteId, busqueda);
      if (candidatos.length === 0) {
        return { texto: `No he encontrado nada parecido a "${busqueda}" en el catálogo de este cliente. Prueba con otra palabra.` };
      }
      const textoLista = candidatos.map((c, i) => `${i + 1}. ${c.producto}`).join('\n');
      await guardarSesion(telefono, 'esperando_seleccion_producto_pedido', {
        ...sesion.contexto, candidatosProducto: candidatos, terminoBusqueda: busqueda, indiceAReemplazar: indice,
      });
      return { texto: `Productos parecidos a "${busqueda}" para sustituir la línea ${indice + 1}:\n\n${textoLista}\n\nResponde con el número.` };
    }

    if (textoNorm.startsWith('cambiar ')) {
      const partes = textoOriginal.slice(8).trim().split(/\s+/);
      const indice = parseInt(partes[0], 10) - 1;
      const nuevaCantidad = parseFloat((partes[1] || '').replace(',', '.'));
      if (isNaN(indice) || !lineas[indice] || isNaN(nuevaCantidad) || nuevaCantidad <= 0) {
        return { texto: 'Escribe "cambiar <número de línea> <cantidad nueva>", ej. "cambiar 2 5".' };
      }
      const lineaOriginal = lineas[indice];
      const nuevasLineas = lineas.map((l, i) => i === indice ? { ...l, cantidad: nuevaCantidad, nota: 'Cantidad corregida a mano', confianza: 'alta' } : l);

      try {
        const textoOrig = (lineaOriginal.texto_original || '').toLowerCase();
        const unidadMatch = textoOrig.match(/caja|cajas|fardo|fardos|bandeja|bandejas|bulto|bultos|pack|carton|cartones|und|unidad|unidades|kg|litro/);

        // Si es una unidad tipo "caja" (de las que normalmente se
        // multiplican por el empaquetado) y podemos leer el número
        // literal que dijo el cliente, calculamos el factor real
        // uds/caja PARA ESTE CLIENTE — no solo memorizamos la cantidad
        // de este pedido, sino la equivalencia, que sirve aunque la
        // próxima vez pida un número distinto de cajas.
        const esUnidadDeCaja = unidadMatch && /caja|cajas|fardo|fardos|bulto|bultos|pack|carton|cartones/.test(unidadMatch[0]);
        const numeroMatch = textoOrig.match(/^\s*(\d+(?:[.,]\d+)?)/);
        const numeroCliente = numeroMatch ? parseFloat(numeroMatch[1].replace(',', '.')) : null;
        const uomCliente = (esUnidadDeCaja && numeroCliente > 0) ? (nuevaCantidad / numeroCliente) : undefined;

        await guardarCantidadAprendida({
          empresa: getEmpresaActiva(), clienteId: sesion.contexto.clienteId, productoId: lineaOriginal.producto_id,
          cantidadTipica: nuevaCantidad, unidadCliente: unidadMatch ? unidadMatch[0] : 'uds',
          uomCliente,
        });
      } catch (err) {
        console.error('Error guardando cantidad aprendida (no bloquea el pedido):', err);
      }

      const resultado = { lineas: nuevasLineas, texto_no_identificado: sesion.contexto.texto_no_identificado || [] };
      try {
        resultado.lineas = await anotarStockLineas(resultado.lineas);
      } catch (errStock) {
        console.error('Error anotando stock (no bloquea):', errStock);
      }
      const mensajeResultado = formatearResultadoPedido(resultado);
      await guardarSesion(telefono, 'esperando_confirmacion_pedido', { ...sesion.contexto, lineas: nuevasLineas, mensaje_resultado: mensajeResultado });
      return { texto: mensajeResultado };
    }

    if (textoNorm.startsWith('quitar ')) {
      const indice = parseInt(textoOriginal.slice(7).trim(), 10) - 1;
      if (isNaN(indice) || !lineas[indice]) {
        return { texto: `No encuentro la línea ${textoOriginal.slice(7).trim()}. Revisa el número y prueba otra vez.` };
      }
      const nuevasLineas = lineas.filter((_, i) => i !== indice);
      const resultado = { lineas: nuevasLineas, texto_no_identificado: sesion.contexto.texto_no_identificado || [] };
      try {
        resultado.lineas = await anotarStockLineas(resultado.lineas);
      } catch (errStock) {
        console.error('Error anotando stock (no bloquea):', errStock);
      }
      const mensajeResultado = formatearResultadoPedido(resultado);
      await guardarSesion(telefono, 'esperando_confirmacion_pedido', { ...sesion.contexto, lineas: nuevasLineas, mensaje_resultado: mensajeResultado });
      return { texto: mensajeResultado };
    }

    if (textoNorm.startsWith('buscar ')) {
      const termino = textoOriginal.slice(7).trim();
      if (termino.length < 2) {
        return { texto: 'Escribe al menos 2 letras para buscar, ej. "buscar peperoni".' };
      }
      const candidatos = await buscarEnCatalogoCliente(getEmpresaActiva(), clienteId, termino);
      if (candidatos.length === 0) {
        return { texto: `No he encontrado nada parecido a "${termino}" en el catálogo de este cliente. Prueba con otra palabra, o sigue con *SI*/*quitar*.` };
      }
      const textoLista = candidatos.map((c, i) => `${i + 1}. ${c.producto}`).join('\n');
      await guardarSesion(telefono, 'esperando_seleccion_producto_pedido', { ...sesion.contexto, candidatosProducto: candidatos, terminoBusqueda: termino });
      return { texto: `Productos parecidos a "${termino}":\n\n${textoLista}\n\nResponde con el número.` };
    }

    const matchNoIdent = textoOriginal.match(/^n(\d+)(?:\s+(.+))?$/i);
    if (matchNoIdent) {
      const listaNoIdent = sesion.contexto.texto_no_identificado || [];
      const idxNoIdent = parseInt(matchNoIdent[1], 10) - 1;
      if (isNaN(idxNoIdent) || !listaNoIdent[idxNoIdent]) {
        return { texto: `No encuentro el "N${matchNoIdent[1]}" en la lista de no identificados.` };
      }
      const { cantidad, nombre: nombreOriginal } = extraerCantidadYNombre(listaNoIdent[idxNoIdent]);
      // Si escribe una palabra de búsqueda propia (ej. "N1 rock"), se usa
      // esa para buscar en vez del texto original del cliente — pero la
      // cantidad sigue saliendo del texto original, no hay que repetirla.
      const nombreBusqueda = matchNoIdent[2] ? matchNoIdent[2].trim() : nombreOriginal;
      const candidatos = await buscarEnCatalogoCliente(getEmpresaActiva(), clienteId, nombreBusqueda);
      if (candidatos.length === 0) {
        return { texto: `No he encontrado nada parecido a "${nombreBusqueda}" en el catálogo de este cliente. Prueba con otra palabra, ej. "N${matchNoIdent[1]} otra-palabra".` };
      }
      const textoLista = candidatos.map((c, i) => `${i + 1}. ${c.producto}`).join('\n');
      await guardarSesion(telefono, 'esperando_seleccion_producto_pedido', {
        ...sesion.contexto, candidatosProducto: candidatos, terminoBusqueda: nombreBusqueda,
        indiceNoIdentificado: idxNoIdent, cantidadSugerida: cantidad,
      });
      return { texto: `Productos parecidos a "${nombreBusqueda}" (cantidad detectada: ${cantidad}):\n\n${textoLista}\n\nResponde con el número.` };
    }

    if (texto !== 'si' && texto !== 'sí') {
      // Puede que el comercial todavía no haya "visto" el resultado
      // (ej. en el panel de pruebas, que no recibe el mensaje aparte) —
      // se lo repetimos en vez de asumir que ya lo tiene.
      return { texto: sesion.contexto.mensaje_resultado || 'Responde *SI* para confirmar el pedido, o escribe *menu* para cancelarlo.' };
    }

    try {
      const resultado = await crearPresupuesto({
        empresa: getEmpresaActiva(), clienteId, direccionId, lineas, notas: 'Pedido vía WhatsApp (copiloto)',
      });

      try {
        // Administración / supervisores (ven todos los clientes): el
        // pedido se asigna al comercial del CLIENTE, no a quien lo mete,
        // para no quitarle la venta. Si el cliente no tiene comercial y
        // quien lo mete tampoco tiene usuario de Odoo, no se toca.
        let vendedor = comercial.odoo_user_id;
        if (comercial.ve_todos_clientes || !vendedor) {
          const [cli] = await searchRead('res.partner', [['id', '=', clienteId]], ['user_id'], { limit: 1 });
          vendedor = (cli && Array.isArray(cli.user_id) && cli.user_id[0]) || comercial.odoo_user_id || null;
        }
        if (vendedor) await asignarVendedorPedido(resultado.order_id, vendedor);
      } catch (err2) {
        console.error('Error asignando vendedor al pedido (el presupuesto sí se creó bien):', err2);
      }

      try {
        await actualizarCatalogoCliente({ empresa: getEmpresaActiva(), clienteId, lineas });
      } catch (err3) {
        console.error('Error actualizando catalogo_cliente (el presupuesto sí se creó bien):', err3);
      }

      let avisosFinal = '';
      try {
        avisosFinal = await generarAvisosCliente({ empresa: getEmpresaActiva(), clienteId, clienteNombre, lineasPedido: lineas });
      } catch (err4) {
        console.error('Error generando avisos finales (no bloquea):', err4);
      }

      const mensajeBase = `✅ Presupuesto *${resultado.ref}* creado para *${clienteNombre}*.\n🔗 ${resultado.portal_url}${avisosFinal}`;

      // Aviso AL CLIENTE (distinto del recuento anterior, que solo ve
      // el comercial) — si hay productos habituales no pedidos, se
      // programa un WhatsApp al cliente con 10 min de margen para
      // cancelar ("no avisar"). Si falta el contacto o hay varios, se
      // le pregunta al comercial antes de seguir.
      try {
        const aviso = await prepararAvisoCliente({ empresa: getEmpresaActiva(), clienteId, clienteNombre, lineasPedido: lineas, comercial });

        if (aviso.estado === 'programado') {
          await guardarSesion(telefono, 'menu', null);
          return { texto: `${mensajeBase}\n\n📤 Voy a avisar a *${aviso.contacto.nombre}* de ${clienteNombre} de que no ha pedido: ${aviso.listaProductos}. Se enviará en ${aviso.minutos} min salvo que escribas *no avisar*.\n\nEscribe *menu* para otra consulta.` };
        }

        if (aviso.estado === 'elegir_contacto') {
          await guardarSesion(telefono, 'esperando_eleccion_contacto_cliente', {
            empresa: getEmpresaActiva(), clienteId, clienteNombre, comercial, contactos: aviso.contactos, listaProductos: aviso.listaProductos, mensajeBase,
          });
          const textoLista = aviso.contactos.map((c, i) => `${i + 1}. ${c.nombre} (${c.telefono})`).join('\n');
          return { texto: `${mensajeBase}\n\n${clienteNombre} no ha pedido: ${aviso.listaProductos}\n\n¿A quién aviso?\n${textoLista}\n\nResponde con el número, o *no avisar* para no avisar.` };
        }

        if (aviso.estado === 'falta_contacto') {
          await guardarSesion(telefono, 'esperando_alta_contacto_cliente', {
            empresa: getEmpresaActiva(), clienteId, clienteNombre, comercial, listaProductos: aviso.listaProductos, mensajeBase,
          });
          return { texto: `${mensajeBase}\n\n${clienteNombre} no ha pedido: ${aviso.listaProductos}\n\nNo tengo ningún contacto de Pedidos guardado para avisarle. Escribe el nombre y teléfono así: *Nombre - Teléfono*, o *no avisar* para no avisar.` };
        }
      } catch (err5) {
        console.error('Error preparando aviso al cliente (no bloquea el pedido):', err5);
      }

      await guardarSesion(telefono, 'menu', null);
      return { texto: `${mensajeBase}\n\nEscribe *menu* para otra consulta.` };
    } catch (err) {
      console.error('Error creando presupuesto:', err);
      return { texto: '⚠️ No he podido crear el presupuesto en Odoo ahora mismo. Inténtalo de nuevo en unos minutos, o escribe *menu*.' };
    }
  }

  // ------------------------------------------------------------
  // PEDIDO — corrección: elegir producto de la búsqueda
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_seleccion_producto_pedido') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const candidatos = sesion.contexto?.candidatosProducto || [];
    if (isNaN(indice) || !candidatos[indice]) {
      return { texto: `Responde con un número entre 1 y ${candidatos.length}, o escribe *menu* para cancelar.` };
    }
    const productoElegido = candidatos[indice];

    // Viene de emparejar un "no identificado" (N1, N2...): ya sabemos
    // la cantidad (la del texto original), así que resolvemos directo
    // sin preguntar otra vez, y quitamos ese ítem de la lista de no
    // identificados.
    if (sesion.contexto.indiceNoIdentificado !== undefined) {
      const { clienteId, clienteNombre, direccionId, lineas, terminoBusqueda, cantidadSugerida, indiceNoIdentificado } = sesion.contexto;
      const noIdentActual = sesion.contexto.texto_no_identificado || [];
      const nuevoNoIdent = noIdentActual.filter((_, i) => i !== indiceNoIdentificado);

      const nuevasLineas = [...lineas, {
        texto_original: productoElegido.producto,
        producto_id: productoElegido.producto_id,
        producto: productoElegido.producto,
        cantidad: cantidadSugerida || 1,
        confianza: 'alta',
        nota: 'Emparejado desde no identificado',
      }];

      try {
        await guardarAliasCliente({
          empresa: getEmpresaActiva(), clienteId, textoCliente: terminoBusqueda,
          productoId: productoElegido.producto_id, productoNombre: productoElegido.producto,
        });
      } catch (err) {
        console.error('Error guardando alias (no bloquea el pedido):', err);
      }

      const resultado = { lineas: nuevasLineas, texto_no_identificado: nuevoNoIdent };
      try {
        resultado.lineas = await anotarStockLineas(resultado.lineas);
      } catch (errStock) {
        console.error('Error anotando stock (no bloquea):', errStock);
      }
      const mensajeResultado = formatearResultadoPedido(resultado);
      await guardarSesion(telefono, 'esperando_confirmacion_pedido', {
        clienteId, clienteNombre, direccionId, lineas: nuevasLineas,
        texto_no_identificado: nuevoNoIdent, mensaje_resultado: mensajeResultado,
      });
      return { texto: mensajeResultado };
    }

    await guardarSesion(telefono, 'esperando_cantidad_producto_pedido', { ...sesion.contexto, productoElegido });
    return { texto: `¿Qué cantidad de *${productoElegido.producto}*?` };
  }

  // ------------------------------------------------------------
  // PEDIDO — corrección: cantidad del producto añadido, y vuelta al resumen
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_cantidad_producto_pedido') {
    const cantidad = parseFloat(textoOriginal.replace(',', '.'));
    if (isNaN(cantidad) || cantidad <= 0) {
      return { texto: 'Escribe solo el número de la cantidad, ej. "2".' };
    }
    const { productoElegido, lineas, terminoBusqueda, clienteId, indiceAReemplazar } = sesion.contexto;

    const nuevaLinea = {
      texto_original: productoElegido.producto,
      producto_id: productoElegido.producto_id,
      producto: productoElegido.producto,
      cantidad,
      confianza: 'alta',
      nota: indiceAReemplazar !== undefined ? 'Producto sustituido a mano' : 'Añadido manualmente',
    };

    const nuevasLineas = indiceAReemplazar !== undefined
      ? lineas.map((l, i) => (i === indiceAReemplazar ? nuevaLinea : l))
      : [...lineas, nuevaLinea];

    if (terminoBusqueda) {
      try {
        await guardarAliasCliente({
          empresa: getEmpresaActiva(), clienteId, textoCliente: terminoBusqueda,
          productoId: productoElegido.producto_id, productoNombre: productoElegido.producto,
        });
      } catch (err) {
        console.error('Error guardando alias (no bloquea el pedido):', err);
      }
    }

    const resultado = { lineas: nuevasLineas, texto_no_identificado: sesion.contexto.texto_no_identificado || [] };
    try {
      resultado.lineas = await anotarStockLineas(resultado.lineas);
    } catch (errStock) {
      console.error('Error anotando stock (no bloquea):', errStock);
    }
    const mensajeResultado = formatearResultadoPedido(resultado);
    await guardarSesion(telefono, 'esperando_confirmacion_pedido', {
      clienteId: sesion.contexto.clienteId,
      clienteNombre: sesion.contexto.clienteNombre,
      direccionId: sesion.contexto.direccionId,
      lineas: nuevasLineas,
      texto_no_identificado: sesion.contexto.texto_no_identificado || [],
      mensaje_resultado: mensajeResultado,
    });
    return { texto: mensajeResultado };
  }

  // ------------------------------------------------------------
  // ESTUDIO — paso 1: nombre del cliente
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_cliente_estudio') {
    if (textoOriginal.length < 2) {
      return { texto: 'Escribe al menos 2 letras del nombre del cliente.' };
    }

    const aliasEncontrados = await buscarAliasCliente(telefono, textoOriginal);
    if (aliasEncontrados.length === 1) {
      return await finalizarEstudio(telefono, aliasEncontrados[0].cliente_id, aliasEncontrados[0].cliente_nombre);
    }

    const odooUserId = sesion.contexto?.odoo_user_id;
    const clientes = await buscarClientesComercial(odooUserId, textoOriginal, comercial.ve_todos_clientes);

    if (clientes.length === 0 && aliasEncontrados.length === 0) {
      return { texto: `No he encontrado ningún cliente tuyo con "${textoOriginal}". Prueba con otro nombre, o escribe *menu* para volver al principio.\n\n¿Es un local que aún no es cliente? Escribe *carta nueva ${textoOriginal}* para estudiar su carta.` };
    }
    if (clientes.length === 1 && aliasEncontrados.length === 0) {
      return await finalizarEstudio(telefono, clientes[0].id, clientes[0].name);
    }
    const vistos = new Set(aliasEncontrados.map((a) => a.cliente_id));
    const lista = [
      ...aliasEncontrados.map((a) => ({ id: a.cliente_id, name: `${a.cliente_nombre} (alias: ${a.alias})` })),
      ...clientes.filter((c) => !vistos.has(c.id)),
    ].slice(0, MAX_CANDIDATOS);
    const textoLista = lista.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    await guardarSesion(telefono, 'esperando_seleccion_cliente_estudio', { candidatos: lista });
    return { texto: `He encontrado varios clientes tuyos, ¿cuál quieres estudiar?\n\n${textoLista}\n\nResponde con el número.` };
  }

  // ------------------------------------------------------------
  // ESTUDIO — paso 1b: elegir cliente de la lista
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_seleccion_cliente_estudio') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const candidatos = sesion.contexto?.candidatos || [];
    if (isNaN(indice) || !candidatos[indice]) {
      return { texto: `Responde con un número entre 1 y ${candidatos.length}, o escribe *menu* para volver al principio.` };
    }
    const elegido = candidatos[indice];
    return await finalizarEstudio(telefono, elegido.id, elegido.name);
  }

  const ESTADOS_SEGUIMIENTO = ['esperando_cliente_seguimiento', 'esperando_seleccion_cliente_seguimiento', 'menu_seguimiento', 'esperando_seleccion_pedido_anterior'];
  if (ESTADOS_SEGUIMIENTO.includes(sesion.estado)) {
    const resultado = await manejarSeguimiento(telefono, textoOriginal, sesion, comercial);
    if (resultado) return resultado;
  }

  const ESTADOS_TAREAS = [
    'menu_tareas', 'tarea_titulo', 'tarea_fecha', 'tarea_implicados',
    'tarea_punto_actual', 'tareas_marcar_seleccion',
  ];
  if (ESTADOS_TAREAS.includes(sesion.estado)) {
    const resultado = await manejarTareas(telefono, textoOriginal, sesion, comercial);
    if (resultado) return resultado;
  }

  // Estado desconocido: reiniciar
  await guardarSesion(telefono, 'menu', null);
  return { texto: MENSAJE_MENU };
}

// ------------------------------------------------------------
// SEGUIMIENTO — elegir cliente (mismo patrón que ESTUDIO/FACTURAS)
// ------------------------------------------------------------
async function manejarSeguimiento(telefono, textoOriginal, sesion, comercial) {
  if (sesion.estado === 'esperando_cliente_seguimiento') {
    if (textoOriginal.length < 2) {
      return { texto: 'Escribe al menos 2 letras del nombre del cliente.' };
    }

    const aliasEncontrados = await buscarAliasCliente(telefono, textoOriginal);
    if (aliasEncontrados.length === 1) {
      return await entrarMenuSeguimiento(telefono, aliasEncontrados[0].cliente_id, aliasEncontrados[0].cliente_nombre);
    }

    const odooUserId = sesion.contexto?.odoo_user_id;
    const clientes = await buscarClientesComercial(odooUserId, textoOriginal, comercial.ve_todos_clientes);

    if (clientes.length === 0 && aliasEncontrados.length === 0) {
      return { texto: `No he encontrado ningún cliente tuyo con "${textoOriginal}". Prueba con otro nombre, o escribe *menu* para volver al principio.\n\n¿Es un local que aún no es cliente? Escribe *carta nueva ${textoOriginal}* para estudiar su carta.` };
    }
    if (clientes.length === 1 && aliasEncontrados.length === 0) {
      return await entrarMenuSeguimiento(telefono, clientes[0].id, clientes[0].name);
    }
    const vistos = new Set(aliasEncontrados.map((a) => a.cliente_id));
    const lista = [
      ...aliasEncontrados.map((a) => ({ id: a.cliente_id, name: `${a.cliente_nombre} (alias: ${a.alias})` })),
      ...clientes.filter((c) => !vistos.has(c.id)),
    ].slice(0, MAX_CANDIDATOS);
    const textoLista = lista.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
    await guardarSesion(telefono, 'esperando_seleccion_cliente_seguimiento', { candidatos: lista });
    return { texto: `He encontrado varios clientes tuyos, ¿cuál quieres seguir?\n\n${textoLista}\n\nResponde con el número.` };
  }

  if (sesion.estado === 'esperando_seleccion_cliente_seguimiento') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const candidatos = sesion.contexto?.candidatos || [];
    if (isNaN(indice) || !candidatos[indice]) {
      return { texto: `Responde con un número entre 1 y ${candidatos.length}, o escribe *menu* para volver al principio.` };
    }
    const elegido = candidatos[indice];
    return await entrarMenuSeguimiento(telefono, elegido.id, elegido.name);
  }

  // ------------------------------------------------------------
  // SEGUIMIENTO — submenú tras elegir cliente. Se queda en este mismo
  // submenú tras cada consulta (no vuelve al menú principal), para
  // poder mirar varias cosas del mismo cliente sin repetir la búsqueda.
  // ------------------------------------------------------------
  if (sesion.estado === 'menu_seguimiento') {
    const { clienteId, clienteNombre } = sesion.contexto || {};
    if (!clienteId) {
      await guardarSesion(telefono, 'menu', null);
      return { texto: MENSAJE_MENU };
    }

    const seguirAqui = `\n\n— — —\n${MENU_SEGUIMIENTO(clienteNombre)}`;

    if (textoOriginal === '1') {
      const texto = await listarEnReparto(clienteId);
      return { texto: `🚚 *En reparto — ${clienteNombre}*\n\n${texto}${seguirAqui}` };
    }
    if (textoOriginal === '2') {
      const texto = await listarRepartidos(clienteId);
      return { texto: `✅ *Repartidos — ${clienteNombre}*\n\n${texto}${seguirAqui}` };
    }
    if (textoOriginal === '3') {
      const texto = await listarSinConfirmar(clienteId);
      return { texto: `📝 *Sin confirmar — ${clienteNombre}*\n\n${texto}${seguirAqui}` };
    }
    if (textoOriginal === '4') {
      const { texto, pedidos } = await listarUltimosPedidos(clienteId);
      if (pedidos.length === 0) {
        return { texto: `${texto}${seguirAqui}` };
      }
      await guardarSesion(telefono, 'esperando_seleccion_pedido_anterior', { clienteId, clienteNombre, pedidos });
      return { texto: `📋 *Últimos pedidos — ${clienteNombre}*\n\n${texto}\n\nResponde con el número para ver el detalle.` };
    }
    if (textoOriginal === '5') {
      const texto = await resumenSemanal(clienteId);
      return { texto: `📅 *Resumen semanal — ${clienteNombre}*\n\n${texto}${seguirAqui}` };
    }

    return { texto: MENU_SEGUIMIENTO(clienteNombre) };
  }

  // ------------------------------------------------------------
  // SEGUIMIENTO — elegir un pedido anterior de la lista
  // ------------------------------------------------------------
  if (sesion.estado === 'esperando_seleccion_pedido_anterior') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const { pedidos, clienteId, clienteNombre } = sesion.contexto || {};
    if (isNaN(indice) || !pedidos?.[indice]) {
      return { texto: `Responde con un número entre 1 y ${pedidos?.length || 0}, o escribe *menu* para volver al principio.` };
    }
    const elegido = pedidos[indice];
    const texto = await detallePedido(elegido.id, elegido.name);
    await guardarSesion(telefono, 'menu_seguimiento', { clienteId, clienteNombre });
    return { texto: `${texto}\n\n— — —\n${MENU_SEGUIMIENTO(clienteNombre)}` };
  }

  return null; // no es un estado de seguimiento
}

/**
 * WhatsApp (vía Twilio) rechaza cualquier mensaje que pase de 1600
 * caracteres, sin avisar al usuario (el mensaje simplemente no llega,
 * sin error visible en nuestro lado). Este envoltorio recorta CUALQUIER
 * respuesta del copiloto que se acerque a ese límite — así queda
 * protegido todo, presente y futuro, sin tener que vigilar cada mensaje
 * uno a uno.
 */
async function procesarMensaje(telefono, textoOriginal, media = null, opciones = {}) {
  const resultado = await procesarMensajeInterno(telefono, textoOriginal, media, opciones);
  // Usuarios de consulta: donde se mostraría el menú completo, se
  // muestra el suyo (sin CLIENTE ni MIS DATOS).
  if (resultado && typeof resultado.texto === 'string' && resultado.texto.includes(MENSAJE_MENU)) {
    try {
      const usuario = await buscarComercial(telefono);
      if (esConsulta(usuario)) resultado.texto = resultado.texto.replace(MENSAJE_MENU, MENSAJE_MENU_CONSULTA);
    } catch (e) { /* si falla, se deja el menú normal */ }
  }
  if (resultado && typeof resultado.texto === 'string' && resultado.texto.length > 1500) {
    resultado.texto = resultado.texto.slice(0, 1497) + '…';
  }
  return resultado;
}

// ------------------------------------------------------------
// TAREAS
// ------------------------------------------------------------
function formatearFechaCorta(fecha) {
  if (!fecha) return '';
  return ` (${new Date(fecha).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })})`;
}

async function manejarTareas(telefono, textoOriginal, sesion, comercial) {
  const texto = textoOriginal.trim().toLowerCase();
  const empresa = getEmpresaActiva();

  // ------------------------------------------------------------
  if (sesion.estado === 'menu_tareas') {
    if (textoOriginal === '1') {
      await guardarSesion(telefono, 'tarea_titulo', {});
      return { texto: '¿Qué título le pones a la tarea? (ej. "Enviar presupuesto a Cliente X", o "Visita cliente Y")' };
    }

    if (textoOriginal === '2') {
      const puntos = await puntosPendientesDe(empresa, telefono);
      if (puntos.length === 0) {
        return { texto: `✅ No tienes tareas pendientes.\n\n${MENU_TAREAS}` };
      }
      const listado = puntos.map((p, i) => `${i + 1}. *${p.tareas.titulo}*${formatearFechaCorta(p.tareas.fecha)}: ${p.descripcion} _(de ${p.tareas.creado_por_nombre})_`).join('\n');
      await guardarSesion(telefono, 'tareas_marcar_seleccion', { puntos });
      return { texto: `📋 *Tus tareas pendientes:*\n\n${listado}\n\nResponde con el número para marcarla hecha, o *menu* para salir.` };
    }

    if (textoOriginal === '3') {
      const tareas = await tareasCreadasPor(empresa, telefono);
      if (tareas.length === 0) {
        return { texto: `No has creado ninguna tarea todavía.\n\n${MENU_TAREAS}` };
      }
      const listado = tareas.map((t) => {
        const puntosTexto = (t.tareas_puntos || [])
          .map((p) => `   ${p.hecho ? '✅' : '⏳'} ${p.responsable_nombre}: ${p.descripcion}`)
          .join('\n');
        return `*${t.titulo}*${formatearFechaCorta(t.fecha)}\n${puntosTexto}`;
      }).join('\n\n');
      return { texto: `📤 *Tareas que has creado:*\n\n${listado}\n\n${MENU_TAREAS}` };
    }

    return { texto: MENU_TAREAS };
  }

  // ------------------------------------------------------------
  if (sesion.estado === 'tarea_titulo') {
    if (textoOriginal.length < 3) {
      return { texto: 'Escribe un título un poco más largo para la tarea.' };
    }
    await guardarSesion(telefono, 'tarea_fecha', { titulo: textoOriginal });
    return { texto: '¿Tiene una fecha concreta? Escribe la fecha (DD/MM), o "no" si no aplica.' };
  }

  // ------------------------------------------------------------
  if (sesion.estado === 'tarea_fecha') {
    let fecha = null;
    if (texto !== 'no') {
      const m = textoOriginal.trim().match(/^(\d{1,2})[\/\-](\d{1,2})$/);
      if (!m) {
        return { texto: 'Escribe la fecha en formato DD/MM (ej. "15/10"), o "no" si no tiene fecha concreta.' };
      }
      const hoy = new Date();
      let anio = hoy.getFullYear();
      const fechaProbable = new Date(anio, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
      if (fechaProbable < hoy) anio++; // si ya pasó este año, se asume el que viene
      fecha = new Date(anio, parseInt(m[2], 10) - 1, parseInt(m[1], 10)).toISOString().slice(0, 10);
    }
    const comercialesActivos = await listarComercialesActivos(empresa);
    const listado = comercialesActivos.map((c, i) => `${i + 1}. ${c.nombre}`).join('\n');
    await guardarSesion(telefono, 'tarea_implicados', { ...sesion.contexto, fecha, comercialesActivos });
    return { texto: `¿A quién implica?\n\n0. Todos\n${listado}\n\nResponde con el/los número(s) separados por comas (ej. "2,4"), o *0* si es para todos.` };
  }

  // ------------------------------------------------------------
  if (sesion.estado === 'tarea_implicados') {
    let personas = [];
    const comercialesActivos = sesion.contexto?.comercialesActivos || [];

    if (texto === '0' || texto === 'todos') {
      personas = comercialesActivos.map((c) => ({ telefono: c.telefono, nombre: c.nombre }));
    } else if (texto === 'solo yo' || texto === 'yo') {
      personas = [{ telefono: comercial.telefono, nombre: comercial.nombre }];
    } else {
      const numeros = textoOriginal.split(',').map((n) => parseInt(n.trim(), 10));
      const invalido = numeros.some((n) => isNaN(n) || n < 1 || n > comercialesActivos.length);
      if (invalido) {
        return { texto: `Responde solo con números de la lista (1 a ${comercialesActivos.length}), separados por comas, o *0* para solo tú.` };
      }
      const indicesUnicos = [...new Set(numeros)];
      personas = indicesUnicos.map((n) => {
        const c = comercialesActivos[n - 1];
        return { telefono: c.telefono, nombre: c.nombre };
      });
    }

    const { titulo, fecha } = sesion.contexto;

    if (personas.length === 1) {
      const tarea = await crearTarea({
        empresa, titulo, fecha,
        creadoPorTelefono: comercial.telefono, creadoPorNombre: comercial.nombre,
        puntos: [{ responsableTelefono: personas[0].telefono, responsableNombre: personas[0].nombre, descripcion: titulo }],
      });
      if (personas[0].telefono !== comercial.telefono) {
        try {
          await enviarMensajeLibre({ to: personas[0].telefono, body: `📌 ${comercial.nombre} te ha asignado una tarea: *${titulo}*${formatearFechaCorta(fecha)}. Escribe *tareas* en el copiloto para verla.` });
        } catch (err) {
          console.error('Error avisando al implicado (no bloquea):', err);
        }
      }
      await guardarSesion(telefono, 'menu_tareas', null);
      return { texto: `✅ Tarea creada: *${titulo}*${formatearFechaCorta(fecha)}, para ${personas[0].nombre}.\n\n${MENU_TAREAS}` };
    }

    // varias personas: hay que preguntar el punto de cada una, una a una
    await guardarSesion(telefono, 'tarea_punto_actual', { titulo, fecha, personas, indice: 0, puntos: [] });
    return { texto: `¿Qué le toca hacer a *${personas[0].nombre}*?` };
  }

  // ------------------------------------------------------------
  if (sesion.estado === 'tarea_punto_actual') {
    if (textoOriginal.length < 2) {
      return { texto: 'Escribe una descripción un poco más larga.' };
    }
    const { titulo, fecha, personas, indice, puntos } = sesion.contexto;
    const nuevosPuntos = [...puntos, {
      responsableTelefono: personas[indice].telefono,
      responsableNombre: personas[indice].nombre,
      descripcion: textoOriginal,
    }];

    if (indice + 1 < personas.length) {
      await guardarSesion(telefono, 'tarea_punto_actual', { titulo, fecha, personas, indice: indice + 1, puntos: nuevosPuntos });
      return { texto: `¿Qué le toca hacer a *${personas[indice + 1].nombre}*?` };
    }

    // ya están todos los puntos, se crea la tarea
    await crearTarea({
      empresa, titulo, fecha,
      creadoPorTelefono: comercial.telefono, creadoPorNombre: comercial.nombre,
      puntos: nuevosPuntos,
    });

    for (const p of nuevosPuntos) {
      if (p.responsableTelefono === comercial.telefono) continue;
      try {
        await enviarMensajeLibre({ to: p.responsableTelefono, body: `📌 ${comercial.nombre} te ha asignado una tarea: *${titulo}*${formatearFechaCorta(fecha)} — ${p.descripcion}. Escribe *tareas* en el copiloto para verla.` });
      } catch (err) {
        console.error('Error avisando a implicado (no bloquea):', err);
      }
    }

    const resumen = nuevosPuntos.map((p) => `   ${p.responsableNombre}: ${p.descripcion}`).join('\n');
    await guardarSesion(telefono, 'menu_tareas', null);
    return { texto: `✅ Tarea creada: *${titulo}*${formatearFechaCorta(fecha)}\n${resumen}\n\n${MENU_TAREAS}` };
  }

  // ------------------------------------------------------------
  if (sesion.estado === 'tareas_marcar_seleccion') {
    const indice = parseInt(textoOriginal, 10) - 1;
    const puntos = sesion.contexto?.puntos || [];
    if (isNaN(indice) || !puntos[indice]) {
      return { texto: `Responde con un número entre 1 y ${puntos.length}, o escribe *menu* para salir.` };
    }
    const elegido = puntos[indice];
    const actualizado = await marcarPuntoHecho(elegido.id);
    const quedan = await quedanPuntosPendientes(elegido.tarea_id);

    const creadorTelefono = actualizado.tareas?.creado_por_telefono;
    if (creadorTelefono && creadorTelefono !== telefono) {
      const mensajeCreador = quedan
        ? `✅ ${comercial.nombre} ha marcado su parte de *${actualizado.tareas?.titulo}* (${actualizado.descripcion}). Aún quedan otros implicados pendientes.`
        : `🎉 *${actualizado.tareas?.titulo}* ya está completa del todo — ${comercial.nombre} acaba de marcar la última parte.`;
      try {
        await enviarMensajeLibre({ to: creadorTelefono, body: mensajeCreador });
      } catch (err) {
        console.error('Error avisando al creador (no bloquea):', err);
      }
    }

    await guardarSesion(telefono, 'menu_tareas', null);
    return { texto: `✅ Marcada: *${actualizado.descripcion}*.\n\n${MENU_TAREAS}` };
  }

  return null; // no es un estado de tareas
}

// ------------------------------------------------------------------
// PROSPECCIÓN: enlace a la web del municipio (y búsqueda si no hay una reciente)
// ------------------------------------------------------------------
function nombreMunicipio(t) {
  const MENORES = new Set(['de', 'del', 'la', 'las', 'los', 'el', 'y']);
  return String(t || '').trim().replace(/\s+/g, ' ').toLowerCase().split(' ')
    .map((w, i) => (i > 0 && MENORES.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ').slice(0, 80);
}

async function lanzarProspeccion(telefono, comercial, municipio, grupoClave) {
  const P = require('./prospeccion');
  await guardarSesion(telefono, 'menu');
  try {
    const empresa = getEmpresaActiva();
    const enlace = await crearEnlace360({ empresa, clienteId: null, clienteNombre: municipio, comercial, modo: 'prospeccion' });
    const url = `${SITE_URL}/prospeccion.html?t=${enlace.token}&g=${grupoClave}`;
    const previa = await P.ultimaBusqueda(empresa, municipio, grupoClave);
    if (previa) {
      const n = (previa.place_ids || []).length;
      return { texto: `🧭 *${municipio}*: ya hay una búsqueda del ${new Date(previa.created_at).toLocaleDateString('es-ES')} con ${n} locales${previa.comercial ? ` (la hizo ${previa.comercial})` : ''}, con el seguimiento de todos.\n\nLista, mapa y seguimiento:\n${url}\n\nDesde la web puedes pedir una búsqueda nueva.` };
    }
    await crearTrabajo({ token: enlace.token }, 'prospeccion', { municipio, grupo: grupoClave, avisar_whatsapp: telefono });
    return { texto: `🧭 Buscando en *${municipio}* (Google Maps) y cruzando con Odoo… tarda uno o dos minutos. Te aviso por aquí.\n\nPuedes ir abriendo la web, se rellena sola:\n${url}` };
  } catch (err) {
    console.error('Error lanzando la prospección:', err);
    return { texto: '⚠️ No he podido empezar la búsqueda ahora mismo. Inténtalo de nuevo en un momento, o escribe *menu*.' };
  }
}

// ------------------------------------------------------------------
// PERMISO DE WHATSAPP de un local de la prospección: "permiso la resolana javier 600111222"
// ------------------------------------------------------------------
function preguntaViaPermiso(local, nombre, movil) {
  return `Registro el permiso de *${nombre || 'el local'}* (${local}) para escribirle al ${movil}.\n\n¿Cómo te lo dio?\n1 Por teléfono\n2 En persona`;
}

async function iniciarPermiso(telefono, resto) {
  const m = resto.match(/(\+?\d[\d\s.-]{7,}\d)\s*$/);
  if (!m) return { texto: 'Escribe *permiso*, el local, el nombre de quien te dio permiso y su móvil. Ej.: *permiso la resolana javier 600111222*' };
  const movil = m[1].replace(/[\s.-]/g, '');
  const palabrasTxt = resto.slice(0, m.index).trim().split(/\s+/).filter(Boolean);
  if (!palabrasTxt.length) return { texto: 'Falta el nombre del local. Ej.: *permiso la resolana javier 600111222*' };
  const sinT = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const empresa = getEmpresaActiva();
  // Locales de la prospección que contengan la palabra más larga
  const larga = [...palabrasTxt].sort((a, b) => b.length - a.length)[0];
  const { data } = await supabase.from('prospeccion_locales').select('place_id, nombre, municipio').eq('empresa', empresa).ilike('nombre', `%${larga}%`).limit(50);
  const locales = data || [];
  // El local son las primeras k palabras (la k más larga que encaje); el resto, el nombre de la persona
  let mejor = null;
  for (let k = palabrasTxt.length; k >= 1 && !mejor; k -= 1) {
    const ps = palabrasTxt.slice(0, k).map(sinT).filter((w) => w.length > 2 || k === 1);
    const encajan = locales.filter((l) => ps.every((w) => sinT(l.nombre).includes(w)));
    if (encajan.length) mejor = { encajan, nombre: palabrasTxt.slice(k).join(' ') };
  }
  if (!mejor) return { texto: `No encuentro "${palabrasTxt.join(' ')}" entre los locales de tus prospecciones. Búscalo antes con *prospectar* y el municipio.` };
  const nombre = mejor.nombre ? mejor.nombre.replace(/(^|\s)(\S)/g, (x, a, b) => a + b.toUpperCase()) : '';
  if (mejor.encajan.length > 1) {
    const candidatos = mejor.encajan.slice(0, 9);
    await guardarSesion(telefono, 'esperando_local_permiso', { candidatos, nombre, movil });
    return { texto: `¿Qué local es?\n\n${candidatos.map((l, i) => `${i + 1} ${l.nombre} (${l.municipio || ''})`).join('\n')}` };
  }
  const l = mejor.encajan[0];
  await guardarSesion(telefono, 'esperando_via_permiso', { place_id: l.place_id, local: l.nombre, municipio: l.municipio, nombre, movil });
  return { texto: preguntaViaPermiso(l.nombre, nombre, movil) };
}

module.exports = { procesarMensaje };
