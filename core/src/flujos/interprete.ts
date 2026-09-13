/**
 * Intérprete de flujos declarativos: ejecuta con Playwright los pasos descritos
 * en FlujoDef y expone el flujo como un Modulo normal, de modo que API, worker y
 * consola lo tratan igual que un módulo escrito en código.
 */
import type { Locator, Page } from 'playwright';
import { z, type ZodType } from 'zod';
import { ErrorNegocio, ErrorPortal, ErrorSesion, type ContextoEjecucion, type Modulo } from '../modulo.js';
import type { Condicion, FlujoDef, Objetivo, OperacionTransformar, ParametroDef, Paso } from './esquema.js';

const ESPERA_POR_DEFECTO = 20_000;

type Vars = Record<string, unknown>;

interface Estado {
  page: Page;
  vars: Vars;
  capturar(nombre: string): Promise<void>;
  log(mensaje: string): void;
  /** Ruta de pasos para mensajes de error: "3 > si > 2". */
  ruta: string[];
}

class FinDelFlujo extends Error {}

// ---------------------------------------------------------------------------------
// Utilidades de valores
// ---------------------------------------------------------------------------------

/** "/patrón/flags" → RegExp; cualquier otro texto → null. */
function aRegex(texto: string): RegExp | null {
  const m = /^\/(.+)\/([a-z]*)$/s.exec(texto);
  return m ? new RegExp(m[1], m[2]) : null;
}

/** Texto o regex para las funciones getBy* de Playwright. */
function aPatron(texto: string): string | RegExp {
  return aRegex(texto) ?? texto;
}

/** Lee una ruta "a.b.0.c" (admite índices negativos) dentro de un objeto. */
export function leerRuta(obj: unknown, ruta: string): unknown {
  let actual: unknown = obj;
  for (const parte of ruta.split('.')) {
    if (actual === null || actual === undefined) return undefined;
    if (Array.isArray(actual) && /^-?\d+$/.test(parte)) {
      const i = Number(parte);
      actual = actual[i < 0 ? actual.length + i : i];
    } else {
      actual = (actual as Record<string, unknown>)[parte];
    }
  }
  return actual;
}

/** Escribe en una ruta "a.b.c", creando objetos intermedios; admite índices (incluidos negativos) en listas. */
export function escribirRuta(obj: Vars, ruta: string, valor: unknown): void {
  const partes = ruta.split('.');
  let actual: unknown = obj;
  for (let i = 0; i < partes.length - 1; i++) {
    const parte = partes[i];
    let siguiente: unknown;
    if (Array.isArray(actual) && /^-?\d+$/.test(parte)) {
      const idx = Number(parte);
      siguiente = actual[idx < 0 ? actual.length + idx : idx];
    } else {
      siguiente = (actual as Record<string, unknown>)[parte];
      if (siguiente === undefined || siguiente === null) {
        siguiente = /^\d+$/.test(partes[i + 1]) ? [] : {};
        (actual as Record<string, unknown>)[parte] = siguiente;
      }
    }
    actual = siguiente;
  }
  const ultima = partes[partes.length - 1];
  if (Array.isArray(actual) && /^-?\d+$/.test(ultima)) {
    const idx = Number(ultima);
    actual[idx < 0 ? actual.length + idx : idx] = valor;
  } else {
    (actual as Record<string, unknown>)[ultima] = valor;
  }
}

const PLANTILLA_COMPLETA = /^\{\{\s*([\w.-]+)\s*\}\}$/;
const PLANTILLA_PARCIAL = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Resuelve plantillas en cualquier valor. Un texto que es exactamente "{{ruta}}"
 * devuelve el valor tal cual (listas, números, objetos); si está incrustado en más
 * texto, se interpola como cadena. Objetos y listas se recorren en profundidad.
 */
export function plantilla(valor: unknown, vars: Vars): unknown {
  if (typeof valor === 'string') {
    const completa = PLANTILLA_COMPLETA.exec(valor);
    if (completa) return leerRuta(vars, completa[1]);
    return valor.replace(PLANTILLA_PARCIAL, (_, ruta: string) => aTexto(leerRuta(vars, ruta)));
  }
  if (Array.isArray(valor)) return valor.map((v) => plantilla(v, vars));
  if (valor && typeof valor === 'object') {
    return Object.fromEntries(Object.entries(valor as Record<string, unknown>).map(([k, v]) => [k, plantilla(v, vars)]));
  }
  return valor;
}

function aTexto(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function limpiar(s: string | null | undefined): string {
  return (s ?? '').replace(/\s+/g, ' ').trim();
}

export function aNumero(texto: unknown): number | null {
  if (typeof texto === 'number') return Number.isFinite(texto) ? texto : null;
  if (typeof texto !== 'string' || !texto.trim()) return null;
  const limpio = texto.replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}

/** dd/mm/aaaa o aaaa-mm-dd → aaaa-mm-dd; cualquier otra cosa → null. */
export function aFechaIso(texto: unknown): string | null {
  if (typeof texto !== 'string') return null;
  const t = texto.trim();
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null;
}

function vacio(v: unknown): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function comparar(a: unknown, b: unknown): number {
  const na = typeof a === 'number' ? a : aNumero(a);
  const nb = typeof b === 'number' ? b : aNumero(b);
  if (na !== null && nb !== null && !(typeof a === 'string' && /[-/]/.test(a))) return na - nb;
  return aTexto(a).localeCompare(aTexto(b));
}

function iguales(a: unknown, b: unknown): boolean {
  if (typeof a === 'boolean' || typeof b === 'boolean') return String(a) === String(b);
  return aTexto(a).trim().toLowerCase() === aTexto(b).trim().toLowerCase();
}

// ---------------------------------------------------------------------------------
// Objetivos y condiciones
// ---------------------------------------------------------------------------------

export function resolverObjetivo(page: Page, objetivo: Objetivo, vars: Vars, todos = false): Locator {
  const o = plantilla(objetivo, vars) as Objetivo;
  const base: Page | Locator = o.dentro_de ? resolverObjetivo(page, o.dentro_de, vars) : page;
  let loc: Locator;
  if (o.selector) loc = base.locator(o.selector);
  else if (o.rol) loc = base.getByRole(o.rol as Parameters<Page['getByRole']>[0], o.nombre ? { name: aPatron(o.nombre) } : undefined);
  else if (o.etiqueta) loc = base.getByLabel(aPatron(o.etiqueta));
  else if (o.placeholder) loc = base.getByPlaceholder(aPatron(o.placeholder));
  else loc = base.getByText(aPatron(o.texto as string), { exact: o.exacto ?? false });
  if (o.con_texto) loc = loc.filter({ hasText: aPatron(o.con_texto) });
  if (o.indice !== undefined) return loc.nth(o.indice);
  return todos ? loc : loc.first();
}

function describirObjetivo(o: Objetivo): string {
  const partes: string[] = [];
  if (o.selector) partes.push(`selector "${o.selector}"`);
  if (o.rol) partes.push(`rol ${o.rol}${o.nombre ? ` "${o.nombre}"` : ''}`);
  if (o.texto) partes.push(`texto "${o.texto}"`);
  if (o.etiqueta) partes.push(`etiqueta "${o.etiqueta}"`);
  if (o.placeholder) partes.push(`placeholder "${o.placeholder}"`);
  if (o.con_texto) partes.push(`con texto "${o.con_texto}"`);
  if (o.indice !== undefined) partes.push(`índice ${o.indice}`);
  if (o.dentro_de) partes.push(`dentro de (${describirObjetivo(o.dentro_de)})`);
  return partes.join(', ');
}

async function visible(loc: Locator, esperaMs: number): Promise<boolean> {
  if (esperaMs > 0) return loc.waitFor({ state: 'visible', timeout: esperaMs }).then(() => true, () => false);
  return loc.isVisible().catch(() => false);
}

export async function evaluar(cond: Condicion, est: Estado): Promise<boolean> {
  const { page, vars } = est;
  if ('todas' in cond) {
    for (const c of cond.todas) if (!(await evaluar(c, est))) return false;
    return true;
  }
  if ('alguna' in cond) {
    for (const c of cond.alguna) if (await evaluar(c, est)) return true;
    return false;
  }
  if ('no' in cond) return !(await evaluar(cond.no, est));
  if ('existe' in cond) return visible(resolverObjetivo(page, cond.existe, vars), cond.espera_ms ?? 0);
  if ('no_existe' in cond) return !(await visible(resolverObjetivo(page, cond.no_existe, vars), cond.espera_ms ?? 0));
  if ('texto_visible' in cond) {
    const patron = aPatron(plantilla(cond.texto_visible, vars) as string);
    return visible(page.getByText(patron).first(), cond.espera_ms ?? 0);
  }
  if ('url_coincide' in cond) {
    const patron = aRegex(cond.url_coincide) ?? new RegExp(cond.url_coincide, 'i');
    return patron.test(page.url());
  }
  const valorVar = leerRuta(vars, cond.variable);
  const esperado = plantilla(cond.valor, vars);
  switch (cond.op) {
    case 'vacio':
      return vacio(valorVar);
    case 'no_vacio':
      return !vacio(valorVar);
    case 'igual':
      return iguales(valorVar, esperado);
    case 'distinto':
      return !iguales(valorVar, esperado);
    case 'contiene':
      if (Array.isArray(valorVar)) return valorVar.some((v) => iguales(v, esperado));
      return aTexto(valorVar).toLowerCase().includes(aTexto(esperado).toLowerCase());
    case 'coincide': {
      const patron = aRegex(aTexto(esperado)) ?? new RegExp(aTexto(esperado), 'i');
      return patron.test(aTexto(valorVar));
    }
    case 'mayor':
      return !vacio(valorVar) && comparar(valorVar, esperado) > 0;
    case 'menor':
      return !vacio(valorVar) && comparar(valorVar, esperado) < 0;
    case 'mayor_igual':
      return !vacio(valorVar) && comparar(valorVar, esperado) >= 0;
    case 'menor_igual':
      return !vacio(valorVar) && comparar(valorVar, esperado) <= 0;
  }
}

// ---------------------------------------------------------------------------------
// Lectura del DOM
// ---------------------------------------------------------------------------------

/**
 * Valor junto a una etiqueta: "Estado: VIGENTE" en el mismo nodo, o el siguiente nodo con texto.
 * El código se pasa como texto: bajo tsx/esbuild, una función con constantes internas
 * llega al navegador con un helper __name que allí no existe.
 */
const CODIGO_LEER_ETIQUETA = `(label) => {
  const limpiar = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const nodos = Array.from(document.querySelectorAll('td, th, span, label, div, b, strong, dt, dd, p, li'));
  const nodo = nodos.find((n) => n.children.length === 0 && limpiar(n.textContent).replace(/:$/, '').toLowerCase().startsWith(label.toLowerCase()));
  if (!nodo) return null;
  const propio = limpiar(nodo.textContent);
  const enLinea = propio.includes(':') ? limpiar(propio.split(':').slice(1).join(':')) : '';
  if (enLinea) return enLinea;
  let sig = nodo.nextElementSibling ?? (nodo.parentElement ? nodo.parentElement.nextElementSibling : null);
  while (sig && !limpiar(sig.textContent)) sig = sig.nextElementSibling;
  return sig ? limpiar(sig.textContent) : null;
}`;

async function leerPorEtiqueta(page: Page, etiqueta: string): Promise<string | null> {
  return page.evaluate(`(${CODIGO_LEER_ETIQUETA})(${JSON.stringify(etiqueta)})`) as Promise<string | null>;
}

async function leerTabla(tabla: Locator, encabezados: boolean): Promise<Array<Record<string, unknown>>> {
  // Función sin constantes internas con nombre: así tsx/esbuild no le inyecta el helper __name.
  const filas = await tabla.evaluate((t) =>
    Array.from(t.querySelectorAll('tr')).map((tr) => ({
      esEncabezado: tr.querySelectorAll('th').length > 0 && tr.querySelectorAll('td').length === 0,
      celdas: Array.from(tr.querySelectorAll('th, td')).map((c) => (c.textContent ?? '').replace(/s+/g, ' ').trim()),
    })),
  );
  if (!encabezados) return filas.filter((f) => !f.esEncabezado && f.celdas.length > 0).map((f) => ({ celdas: f.celdas }));
  const cab = filas.find((f) => f.esEncabezado) ?? filas[0];
  const claves = (cab?.celdas ?? []).map((c, i) => c.toLowerCase().replace(/[^a-z0-9áéíóúñ]+/g, '_').replace(/^_|_$/g, '') || `col_${i}`);
  return filas
    .filter((f) => f !== cab && !f.esEncabezado && f.celdas.length > 0)
    .map((f) => Object.fromEntries(f.celdas.map((c, i) => [claves[i] ?? `col_${i}`, c])));
}

function convertir(valor: string | null, como: 'texto' | 'numero' | 'fecha' | undefined, extraer: string | undefined): unknown {
  let v: string | null = valor;
  if (v !== null && extraer) {
    const re = aRegex(extraer) ?? new RegExp(extraer, 'i');
    const m = re.exec(v);
    v = m ? (m[1] ?? m[0]) : null;
  }
  if (como === 'numero') return aNumero(v);
  if (como === 'fecha') return aFechaIso(v);
  return v;
}

// ---------------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------------

function fallo(est: Estado, paso: Paso, mensaje: string): ErrorPortal {
  const donde = est.ruta.join(' > ');
  return new ErrorPortal(`Paso ${donde} (${paso.tipo}${paso.titulo ? `: ${paso.titulo}` : ''}): ${mensaje}`);
}

async function ejecutarPaso(paso: Paso, est: Estado): Promise<void> {
  const { page, vars } = est;
  const timeout = paso.timeout_ms ?? ESPERA_POR_DEFECTO;
  const t = (v: unknown) => plantilla(v, vars);
  const s = (v: unknown) => aTexto(t(v));

  switch (paso.tipo) {
    case 'ir':
      await page.goto(s(paso.url), { waitUntil: 'domcontentloaded', timeout });
      return;

    case 'clic': {
      const loc = resolverObjetivo(page, paso.objetivo, vars);
      if (paso.opcional) {
        if (await visible(loc, Math.min(timeout, 3_000))) await loc.click({ timeout });
        return;
      }
      await loc.click({ timeout });
      return;
    }

    case 'escribir': {
      const loc = resolverObjetivo(page, paso.objetivo, vars);
      await loc.fill(s(paso.valor), { timeout });
      if (paso.tecla) await loc.press(paso.tecla);
      return;
    }

    case 'seleccionar': {
      const loc = resolverObjetivo(page, paso.objetivo, vars);
      await loc.waitFor({ timeout });
      if (paso.valor !== undefined) {
        await loc.selectOption(s(paso.valor), { timeout });
        return;
      }
      const texto = s(paso.texto);
      const valor = await loc.locator('option').filter({ hasText: aPatron(texto) }).first().getAttribute('value', { timeout });
      if (valor === null) throw fallo(est, paso, `no existe la opción "${texto}"`);
      await loc.selectOption(valor, { timeout });
      return;
    }

    case 'presionar': {
      const loc = paso.objetivo ? resolverObjetivo(page, paso.objetivo, vars) : page.locator('body');
      await loc.press(paso.tecla, { timeout });
      return;
    }

    case 'esperar': {
      let ok = true;
      try {
        if (paso.ms !== undefined) await page.waitForTimeout(paso.ms);
        if (paso.url) await page.waitForURL(aRegex(s(paso.url)) ?? new RegExp(s(paso.url), 'i'), { timeout });
        if (paso.texto) await page.getByText(aPatron(s(paso.texto))).first().waitFor({ timeout });
        if (paso.objetivo) {
          const loc = resolverObjetivo(page, paso.objetivo, vars);
          await loc.waitFor({ timeout });
          if (paso.habilitado) {
            const limite = Date.now() + timeout;
            while (!(await loc.isEnabled())) {
              if (Date.now() > limite) throw new Error('el elemento no se habilitó');
              await page.waitForTimeout(250);
            }
          }
        }
      } catch (e) {
        if (!paso.opcional) throw fallo(est, paso, `no apareció lo esperado (${(e as Error).message.split('\n')[0]})`);
        ok = false;
      }
      if (paso.guardar_como) escribirRuta(vars, paso.guardar_como, ok);
      return;
    }

    case 'leer': {
      let valor: string | null = null;
      if (paso.etiqueta) {
        valor = await leerPorEtiqueta(page, s(paso.etiqueta));
      } else if (paso.objetivo) {
        const loc = resolverObjetivo(page, paso.objetivo, vars);
        if (await visible(loc, Math.min(timeout, 3_000))) {
          valor = paso.atributo ? await loc.getAttribute(paso.atributo, { timeout }) : limpiar(await loc.innerText({ timeout }));
        }
      }
      escribirRuta(vars, paso.guardar_como, convertir(valor, paso.como, paso.extraer ? s(paso.extraer) : undefined));
      return;
    }

    case 'leer_lista': {
      // Todos los candidatos, no solo el primero.
      const loc = resolverObjetivo(page, paso.objetivo, vars, true);
      let textos = (await loc.allInnerTexts().catch(() => [] as string[])).map(limpiar).filter(Boolean);
      if (paso.coincide) {
        const re = aRegex(s(paso.coincide)) ?? new RegExp(s(paso.coincide), 'i');
        textos = textos.filter((x) => re.test(x));
      }
      if (paso.unicos) textos = [...new Set(textos)];
      escribirRuta(vars, paso.guardar_como, textos);
      return;
    }

    case 'leer_tabla': {
      const loc = resolverObjetivo(page, paso.objetivo, vars);
      const hay = await visible(loc, Math.min(timeout, 3_000));
      escribirRuta(vars, paso.guardar_como, hay ? await leerTabla(loc, paso.encabezados ?? true) : []);
      return;
    }

    case 'leer_lineas': {
      const texto = await page.locator('body').innerText({ timeout });
      let lineas = texto.split('\n').map((l) => l.trim()).filter(Boolean);
      if (paso.despues_de) {
        const re = aRegex(s(paso.despues_de)) ?? new RegExp(s(paso.despues_de), 'i');
        const i = lineas.findIndex((l) => re.test(l));
        lineas = i >= 0 ? lineas.slice(i + 1) : [];
      }
      escribirRuta(vars, paso.guardar_como, lineas);
      return;
    }

    case 'capturar':
      await est.capturar(s(paso.nombre));
      return;

    case 'asignar':
      escribirRuta(vars, paso.variable, t(paso.valor));
      return;

    case 'agregar': {
      const actual = leerRuta(vars, paso.a);
      const lista = Array.isArray(actual) ? actual : [];
      lista.push(t(paso.valor));
      if (!Array.isArray(actual)) escribirRuta(vars, paso.a, lista);
      return;
    }

    case 'buscar': {
      const origen = t(paso.en);
      let lista = Array.isArray(origen) ? [...origen] : [];
      if (paso.desde_el_final) lista.reverse();
      if (paso.coincide) {
        const re = aRegex(s(paso.coincide)) ?? new RegExp(s(paso.coincide), 'i');
        lista = lista.filter((x) => re.test(aTexto(x)));
      }
      if (paso.distinto_de !== undefined) {
        const excluido = t(paso.distinto_de);
        lista = lista.filter((x) => !iguales(x, excluido));
      }
      escribirRuta(vars, paso.guardar_como, paso.todos ? lista : (lista[0] ?? null));
      return;
    }

    case 'transformar': {
      let v = leerRuta(vars, paso.variable);
      for (const op of paso.operaciones) v = aplicarOperacion(v, op, vars);
      escribirRuta(vars, paso.guardar_como ?? paso.variable, v);
      return;
    }

    case 'elegir': {
      const origen = t(paso.de);
      const lista = Array.isArray(origen) ? origen : [];
      const como = paso.como ?? 'it';
      const ordenar = (xs: unknown[]) => {
        if (!paso.ordenar_por) return xs;
        const campo = paso.ordenar_por;
        return [...xs].sort((a, b) => comparar(leerRuta(a, campo), leerRuta(b, campo)) * (paso.desc ? -1 : 1));
      };
      let elegido: unknown = null;
      for (const cond of paso.preferir ?? []) {
        const filtrados: unknown[] = [];
        for (const item of lista) {
          if (await evaluar(cond, { ...est, vars: { ...vars, [como]: item } })) filtrados.push(item);
        }
        if (filtrados.length) {
          elegido = ordenar(filtrados)[0];
          break;
        }
      }
      if (elegido === null && lista.length) elegido = ordenar(lista)[0];
      escribirRuta(vars, paso.guardar_como, elegido);
      return;
    }

    case 'decidir': {
      for (const regla of paso.reglas) {
        if (await evaluar(regla.cuando, est)) {
          escribirRuta(vars, paso.guardar_como, t(regla.valor));
          return;
        }
      }
      escribirRuta(vars, paso.guardar_como, t(paso.por_defecto ?? null));
      return;
    }

    case 'si': {
      const cumple = await evaluar(paso.condicion, est);
      const rama = cumple ? paso.entonces : (paso.si_no ?? []);
      await ejecutarPasos(rama, { ...est, ruta: [...est.ruta, cumple ? 'si' : 'si_no'] });
      return;
    }

    case 'para_cada': {
      const origen = t(paso.lista);
      const lista = Array.isArray(origen) ? origen : [];
      const como = paso.como ?? 'it';
      for (let i = 0; i < lista.length; i++) {
        vars[como] = lista[i];
        vars[`${como}_indice`] = i;
        await ejecutarPasos(paso.pasos, { ...est, ruta: [...est.ruta, `para_cada[${i}]`] });
      }
      delete vars[como];
      delete vars[`${como}_indice`];
      return;
    }

    case 'error': {
      const mensaje = s(paso.mensaje);
      if (paso.clase === 'sesion') throw new ErrorSesion(mensaje);
      if (paso.clase === 'portal') throw new ErrorPortal(mensaje);
      throw new ErrorNegocio(paso.codigo, mensaje);
    }

    case 'fin':
      throw new FinDelFlujo();
  }
}

function aplicarOperacion(v: unknown, op: OperacionTransformar, vars: Vars): unknown {
  const sobreCada = (f: (x: unknown) => unknown) => (Array.isArray(v) ? v.map(f) : f(v));
  if ('reemplazar' in op) {
    const [patron, repl] = op.reemplazar;
    const re = aRegex(patron) ?? new RegExp(patron, 'g');
    return sobreCada((x) => (typeof x === 'string' ? x.replace(re, repl) : x));
  }
  if ('extraer' in op) return sobreCada((x) => convertir(typeof x === 'string' ? x : null, undefined, op.extraer));
  if ('recortar' in op) return sobreCada((x) => (typeof x === 'string' ? limpiar(x) : x));
  if ('mayusculas' in op) return sobreCada((x) => (typeof x === 'string' ? x.toUpperCase() : x));
  if ('minusculas' in op) return sobreCada((x) => (typeof x === 'string' ? x.toLowerCase() : x));
  if ('numero' in op) return sobreCada(aNumero);
  if ('fecha' in op) return sobreCada(aFechaIso);
  if ('unicos' in op) return Array.isArray(v) ? [...new Set(v.map(aTexto))] : v;
  if ('largo' in op) return Array.isArray(v) ? v.length : aTexto(v).length;
  if ('por_defecto' in op) return vacio(v) ? plantilla(op.por_defecto, vars) : v;
  return v;
}

export async function ejecutarPasos(pasos: Paso[], est: Estado): Promise<void> {
  for (let i = 0; i < pasos.length; i++) {
    const paso = pasos[i];
    const sub: Estado = { ...est, ruta: [...est.ruta, String(i + 1)] };
    est.log(`paso ${sub.ruta.join('.')} ${paso.tipo}${paso.titulo ? ` · ${paso.titulo}` : ''}`);
    try {
      await ejecutarPaso(paso, sub);
    } catch (e) {
      if (e instanceof FinDelFlujo || e instanceof ErrorNegocio || e instanceof ErrorSesion || e instanceof ErrorPortal) throw e;
      const msg = (e as Error).message.split('\n')[0];
      const detalle = 'objetivo' in paso && paso.objetivo ? ` [${describirObjetivo(paso.objetivo)}]` : '';
      throw fallo(sub, paso, `${msg}${detalle}`);
    }
  }
}

// ---------------------------------------------------------------------------------
// Flujo completo como Modulo
// ---------------------------------------------------------------------------------

export function esquemaParametros(defs: ParametroDef[]): ZodType {
  const forma: Record<string, ZodType> = {};
  for (const d of defs) {
    let tipo: ZodType;
    switch (d.tipo) {
      case 'numero':
        tipo = z.coerce.number();
        break;
      case 'fecha':
        tipo = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, `${d.nombre} debe ser AAAA-MM-DD`);
        break;
      case 'opcion': {
        const valores = (d.opciones ?? []).map((o) => (Array.isArray(o) ? o[0] : o));
        tipo = valores.length ? z.enum(valores as [string, ...string[]]) : z.string();
        break;
      }
      case 'booleano':
        tipo = z.coerce.boolean();
        break;
      default:
        tipo = d.patron ? z.string().regex(new RegExp(d.patron), `${d.nombre} no tiene el formato esperado`) : z.string().min(1);
    }
    if (d.por_defecto !== undefined) tipo = tipo.default(d.por_defecto as never);
    else if (!d.requerido) tipo = tipo.optional();
    forma[d.nombre] = tipo;
  }
  return z.object(forma);
}

function variablesIniciales(ctx: Pick<ContextoEjecucion<Record<string, unknown>>, 'parametros' | 'config' | 'credenciales'>): Vars {
  return {
    ...ctx.parametros,
    config: ctx.config,
    credenciales: ctx.credenciales,
    hoy: new Date().toISOString().slice(0, 10),
    observaciones: [],
  };
}

const INTERNAS = new Set(['config', 'credenciales', 'hoy']);

/** Convierte una definición declarativa en un Modulo que API, worker y consola pueden usar. */
export function moduloDesdeFlujo(def: FlujoDef, version = 0): Modulo {
  const parametros = esquemaParametros(def.parametros);
  const sinCaptura = async () => undefined;
  const silencio = () => undefined;

  return {
    nombre: def.nombre,
    sector: def.sector,
    portal: def.portal,
    version: String(version),
    descripcion: def.descripcion || def.titulo,
    urlInicio: def.url_inicio,
    parametros,
    credencialesRequeridas: def.credenciales_requeridas,

    async sesionValida(page: Page): Promise<boolean> {
      const est: Estado = { page, vars: { url: page.url() }, capturar: sinCaptura, log: silencio, ruta: [] };
      return evaluar(def.sesion.valida_si, est).catch(() => false);
    },

    iniciarSesion: def.sesion.login
      ? async (page: Page, credenciales: Record<string, string>): Promise<void> => {
          const est: Estado = { page, vars: { credenciales, url: page.url() }, capturar: sinCaptura, log: silencio, ruta: ['login'] };
          try {
            await ejecutarPasos(def.sesion.login as Paso[], est);
          } catch (e) {
            if (e instanceof FinDelFlujo) return;
            if (e instanceof ErrorSesion) throw e;
            throw new ErrorSesion((e as Error).message);
          }
        }
      : undefined,

    async ejecutar(ctx: ContextoEjecucion<Record<string, unknown>>): Promise<unknown> {
      const vars = variablesIniciales(ctx);
      const est: Estado = { page: ctx.page, vars, capturar: ctx.capturar, log: ctx.log, ruta: [] };
      try {
        await ejecutarPasos(def.pasos, est);
      } catch (e) {
        if (!(e instanceof FinDelFlujo)) throw e;
      }
      if (def.resultado) return plantilla(def.resultado, vars);
      return Object.fromEntries(Object.entries(vars).filter(([k]) => !INTERNAS.has(k) && !(k in ctx.parametros)));
    },
  };
}
