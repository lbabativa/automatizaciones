/**
 * Resultados de lotes y plantillas en CSV (con ; y BOM, como lo abre Excel en español) o en
 * XLSX. El XLSX se arma a mano (zip con zlib), sin dependencias.
 */
import { crc32, deflateRawSync } from 'node:zlib';
import { itemsDeLote, MAX_ITEMS_LOTE, type ItemDeLote, type LoteDoc, type ParametroDef } from '@startia/core';
import type { Context } from 'hono';

export type Celda = string | number | boolean | null | undefined;

export const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const esObjeto = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** Una fila por consulta: parámetros, estado, cada campo del resultado y el error. */
export function filasResultado(items: ItemDeLote[]): Celda[][] {
  const claves = (obtener: (it: ItemDeLote) => Record<string, unknown> | null) => {
    const orden: string[] = [];
    for (const it of items) for (const k of Object.keys(obtener(it) ?? {})) if (!orden.includes(k)) orden.push(k);
    return orden;
  };
  const parametros = claves((it) => it.parametros);
  const campos = claves((it) => (esObjeto(it.resultado) ? it.resultado : null));
  const otroResultado = items.some((it) => it.resultado !== null && it.resultado !== undefined && !esObjeto(it.resultado));
  const plano = (v: unknown): Celda => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : (v as Celda));
  const cabecera = ['fila', ...parametros, 'estado', 'desde_cache', ...campos, ...(otroResultado ? ['resultado'] : []), 'error_codigo', 'error_mensaje', 'terminado_en', 'duracion_s'];
  const filas = items.map((it) => {
    const r = esObjeto(it.resultado) ? it.resultado : {};
    return [
      it.indice + 1,
      ...parametros.map((k) => plano(it.parametros[k])),
      it.estado,
      it.desde_cache ? 'sí' : 'no',
      ...campos.map((k) => plano(r[k])),
      ...(otroResultado ? [esObjeto(it.resultado) ? '' : plano(it.resultado)] : []),
      it.error?.codigo ?? '',
      it.error?.mensaje ?? '',
      it.terminado_en ? new Date(it.terminado_en).toISOString() : '',
      typeof it.duracion_ms === 'number' ? Math.round(it.duracion_ms / 1000) : '',
    ];
  });
  return [cabecera, ...filas];
}

/** Cabecera con los nombres de los parámetros y una fila de ejemplo. */
export function filasPlantilla(parametros: ParametroDef[]): Celda[][] {
  const ejemplo = (p: ParametroDef): Celda => {
    if (p.ejemplo) return p.ejemplo;
    if (p.por_defecto !== undefined) return String(p.por_defecto);
    if (p.tipo === 'opcion') {
      const o = (p.opciones ?? [])[0];
      return Array.isArray(o) ? o[0] : (o ?? '');
    }
    if (p.tipo === 'fecha') return new Date().toISOString().slice(0, 10);
    if (p.tipo === 'numero') return 1;
    if (p.tipo === 'booleano') return 'sí';
    return /doc|cedula|identific/.test(p.nombre) ? '1234567890' : '';
  };
  return [parametros.map((p) => p.nombre), parametros.map(ejemplo)];
}

export function aCsv(filas: Celda[][]): string {
  const celda = (v: Celda) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Un texto que empieza por = + - @ se abriría como fórmula en Excel.
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + filas.map((f) => f.map(celda).join(';')).join('\r\n') + '\r\n';
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xml = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const columna = (i: number) => {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Libro de una hoja: la primera fila en negrilla y fija, textos como texto (conserva ceros a la izquierda). */
export function aXlsx(filas: Celda[][], hoja = 'Resultados'): Buffer {
  const nombreHoja = xml(hoja.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Hoja1');
  const columnas = Math.max(0, ...filas.map((f) => f.length));
  const anchos = Array.from({ length: columnas }, (_, c) => Math.min(60, Math.max(8, ...filas.slice(0, 300).map((f) => String(f[c] ?? '').length + 2))));
  const datos = filas
    .map((f, r) => {
      const celdas = f
        .map((v, c) => {
          const ref = `${columna(c)}${r + 1}`;
          const estilo = r === 0 ? ' s="1"' : '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"${estilo}><v>${v}</v></c>`;
          const t = v === null || v === undefined ? '' : String(v);
          return t === '' ? '' : `<c r="${ref}" t="inlineStr"${estilo}><is><t xml:space="preserve">${xml(t)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${celdas}</row>`;
    })
    .join('');
  const cabecera = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const archivos: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      `${cabecera}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    ],
    ['_rels/.rels', `${cabecera}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${cabecera}<workbook xmlns="${NS}" xmlns:r="${NS_REL}"><sheets><sheet name="${nombreHoja}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    [
      'xl/_rels/workbook.xml.rels',
      `${cabecera}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
    ],
    [
      'xl/styles.xml',
      `${cabecera}<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
    ],
    [
      'xl/worksheets/sheet1.xml',
      `${cabecera}<worksheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${columnas ? `<cols>${anchos.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : ''}<sheetData>${datos}</sheetData></worksheet>`,
    ],
  ];
  return zip(archivos.map(([nombre, contenido]) => ({ nombre, datos: Buffer.from(contenido, 'utf8') })));
}

function zip(archivos: Array<{ nombre: string; datos: Buffer }>): Buffer {
  const partes: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const d = new Date();
  const hora = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const dia = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const a of archivos) {
    const nombre = Buffer.from(a.nombre, 'utf8');
    const comprimido = deflateRawSync(a.datos);
    const crc = crc32(a.datos);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(dia, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(a.datos.length, 22);
    local.writeUInt16LE(nombre.length, 26);
    local.writeUInt16LE(0, 28);
    partes.push(local, nombre, comprimido);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(hora, 12);
    c.writeUInt16LE(dia, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comprimido.length, 20);
    c.writeUInt32LE(a.datos.length, 24);
    c.writeUInt16LE(nombre.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, nombre);
    offset += local.length + nombre.length + comprimido.length;
  }
  const directorio = Buffer.concat(central);
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(archivos.length, 8);
  fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(directorio.length, 12);
  fin.writeUInt32LE(offset, 16);
  return Buffer.concat([...partes, directorio, fin]);
}

const nombreArchivo = (lote: LoteDoc) => {
  const base = String(lote.nombre || lote._id)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `lote-${lote.clienteSlug}-${base || String(lote._id)}`;
};

/** Respuesta de descarga con los resultados del lote (`?formato=xlsx` por defecto, o `csv`). */
export async function respuestaResultado(c: Context, lote: LoteDoc) {
  const { items } = await itemsDeLote(lote, { limite: MAX_ITEMS_LOTE });
  const filas = filasResultado(items);
  const archivo = nombreArchivo(lote);
  if (c.req.query('formato') === 'csv') {
    return c.body(aCsv(filas), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${archivo}.csv"`, 'cache-control': 'no-store' });
  }
  return c.body(new Uint8Array(aXlsx(filas)), 200, { 'content-type': TIPO_XLSX, 'content-disposition': `attachment; filename="${archivo}.xlsx"`, 'cache-control': 'no-store' });
}
