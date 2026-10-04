// /.netlify/functions/usuarios  (solo ADMIN)
// GET  → lista de usuarios
// POST → crear  { nombre, pin, rol }
// PUT  → editar { id, nombre?, rol?, pin?, activo? }
const {
  supabase, respuesta, leerBody, pinValido, hashPin, pinEnUso, requerirUsuario
} = require('./_lib');

const ROLES = ['ADMIN', 'MONITORA'];

async function adminsActivos(excluirId) {
  const { data } = await supabase.from('usuarios').select('id').eq('rol', 'ADMIN').eq('activo', true);
  return (data || []).filter(u => u.id !== excluirId).length;
}

exports.handler = async (event) => {
  const { usuario: yo, error: errAuth } = await requerirUsuario(event, ['ADMIN']);
  if (errAuth) return errAuth;

  try {
    if (event.httpMethod === 'GET') {
      const { data, error } = await supabase
        .from('usuarios').select('id, nombre, rol, activo, created_at')
        .order('activo', { ascending: false }).order('nombre');
      if (error) throw error;
      return respuesta(200, { usuarios: data });
    }

    const body = leerBody(event);

    if (event.httpMethod === 'POST') {
      const nombre = String(body.nombre || '').trim();
      const rol = body.rol || 'MONITORA';
      if (!nombre) return respuesta(400, { error: 'Escribe el nombre.' });
      if (!ROLES.includes(rol)) return respuesta(400, { error: 'Rol no válido.' });
      if (!pinValido(body.pin)) return respuesta(400, { error: 'El PIN debe tener entre 4 y 6 números.' });
      if (await pinEnUso(body.pin)) return respuesta(409, { error: 'Ese PIN ya lo usa otra persona. Elige otro.' });

      const { data, error } = await supabase
        .from('usuarios').insert({ nombre, rol, pin_hash: hashPin(body.pin) })
        .select('id, nombre, rol, activo').single();
      if (error) throw error;
      return respuesta(200, { usuario: data });
    }

    if (event.httpMethod === 'PUT') {
      const id = Number(body.id);
      if (!id) return respuesta(400, { error: 'Falta el usuario.' });
      const cambios = {};

      if (body.nombre !== undefined) {
        const nombre = String(body.nombre).trim();
        if (!nombre) return respuesta(400, { error: 'El nombre no puede quedar vacío.' });
        cambios.nombre = nombre;
      }
      if (body.rol !== undefined) {
        if (!ROLES.includes(body.rol)) return respuesta(400, { error: 'Rol no válido.' });
        if (body.rol !== 'ADMIN' && (await adminsActivos(id)) === 0) {
          return respuesta(400, { error: 'Tiene que quedar al menos un administrador.' });
        }
        cambios.rol = body.rol;
      }
      if (body.activo !== undefined) {
        if (!body.activo && id === yo.id) return respuesta(400, { error: 'No puedes desactivarte a ti mismo.' });
        if (!body.activo && (await adminsActivos(id)) === 0) {
          return respuesta(400, { error: 'Tiene que quedar al menos un administrador.' });
        }
        cambios.activo = !!body.activo;
      }
      if (body.pin !== undefined && body.pin !== '') {
        if (!pinValido(body.pin)) return respuesta(400, { error: 'El PIN debe tener entre 4 y 6 números.' });
        if (await pinEnUso(body.pin, id)) return respuesta(409, { error: 'Ese PIN ya lo usa otra persona. Elige otro.' });
        cambios.pin_hash = hashPin(body.pin);
      }
      if (!Object.keys(cambios).length) return respuesta(400, { error: 'No hay cambios que guardar.' });

      const { data, error } = await supabase
        .from('usuarios').update(cambios).eq('id', id)
        .select('id, nombre, rol, activo').single();
      if (error) throw error;
      return respuesta(200, { usuario: data });
    }

    return respuesta(405, { error: 'Método no permitido' });
  } catch (e) {
    console.error('usuarios error', e);
    return respuesta(500, { error: 'Error del servidor. Inténtalo de nuevo.' });
  }
};
