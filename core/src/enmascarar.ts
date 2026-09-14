/**
 * Enmascarado de datos personales para la página de seguimiento: documentos con los últimos 4
 * dígitos, nombres con iniciales y datos de contacto ocultos. Se decide por el nombre del campo.
 */
const DOCUMENTO = /doc|cedula|identific|nit|pasaporte|afiliado/i;
const NOMBRE = /nombre|apellido|paciente|titular|beneficiario/i;
const CONTACTO = /correo|email|telefono|celular|direccion/i;

export function enmascararValor(clave: string, valor: unknown): unknown {
  const v = typeof valor === 'number' ? String(valor) : valor;
  if (typeof v !== 'string' || v === '') return valor;
  if (DOCUMENTO.test(clave) && !/tipo/i.test(clave)) return v.length <= 4 ? '****' : `****${v.slice(-4)}`;
  if (NOMBRE.test(clave)) return v.split(/\s+/).filter(Boolean).map((p) => `${p[0].toUpperCase()}.`).join(' ');
  if (CONTACTO.test(clave)) return '***';
  return valor;
}

/** Recorre objetos y listas y enmascara cada campo según su nombre. */
export function enmascararObjeto(valor: unknown, clave = ''): unknown {
  if (Array.isArray(valor)) return valor.map((v) => enmascararObjeto(v, clave));
  if (valor && typeof valor === 'object' && !(valor instanceof Date)) {
    return Object.fromEntries(Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, enmascararObjeto(v, k)]));
  }
  return clave ? enmascararValor(clave, valor) : valor;
}

export function enmascararItem<T extends { parametros: unknown; resultado: unknown }>(item: T): T {
  return { ...item, parametros: enmascararObjeto(item.parametros), resultado: enmascararObjeto(item.resultado) };
}
