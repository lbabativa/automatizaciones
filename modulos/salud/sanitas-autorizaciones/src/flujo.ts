/**
 * Flujo del Validador de Usuarios Sanitas v11.0.3, tomado del video de referencia (11/03/2026).
 *
 * Los selectores marcados VERIFICAR se confirman en la fase 0 con `npx playwright codegen`.
 * El portal es JSF/Seam: cada cambio dispara AJAX, por eso hay esperas explícitas entre pasos.
 */
import { ErrorNegocio, ErrorPortal, type ContextoEjecucion } from '@startia/core';
import type { Locator, Page } from 'playwright';
import type { ParametrosSanitas } from './index.js';

export interface Autorizacion {
  numero: string;
  tipo: string;
  fecha_aprobacion: string | null;
  fecha_vigencia: string | null;
  estado: string;
  prestador: string;
  cups: string | null;
  descripcion: string | null;
  cantidad: number | null;
  vigente_hoy: boolean;
  vigente_en_cita: boolean | null;
}

export interface ResultadoSanitas {
  paciente: {
    nombre: string | null;
    tipo_doc: string;
    num_doc: string;
    estado_afiliacion: string | null;
    compania: string | null;
    plan: string | null;
    contrato: string | null;
    familia: string | null;
    telefono: string | null;
    correo: string | null;
    fecha_nacimiento: string | null;
    edad: string | null;
    sexo: string | null;
  };
  contrato_consultado: string | null;
  contratos_disponibles: string[];
  autorizaciones: Autorizacion[];
  autorizacion_seleccionada: Autorizacion | null;
  copago: {
    condicion: string | null;
    valor_recaudo: number | null;
    porcentaje_copago: number | null;
    valor_pago_compartido: number | null;
    tope_maximo: number | null;
  } | null;
  semaforo: 'VERDE' | 'AMARILLO' | 'ROJO';
  observaciones: string[];
}

const ESPERA = 20_000;

export async function consultarAutorizaciones(ctx: ContextoEjecucion<ParametrosSanitas>): Promise<ResultadoSanitas> {
  const { page, parametros, config, log } = ctx;
  const prestadorCodigo = String(config.prestadorCodigo ?? '');
  if (!prestadorCodigo) throw new ErrorPortal('El cliente no tiene configurado prestadorCodigo para sanitas-autorizaciones');
  const observaciones: string[] = [];

  // ---- 1. Formulario de búsqueda -------------------------------------------------
  await page.getByText('Validación - búsqueda de Usuario').waitFor({ timeout: ESPERA });
  await page.getByText('Limpiar', { exact: true }).click().catch(() => undefined);

  const selects = page.getByRole('combobox');
  const selPrestador = selects.nth(0); // VERIFICAR: orden de los combos (Prestador, Tipo doc, Compañía)
  const selTipoDoc = selects.nth(1);
  const selCompania = selects.nth(2);

  await seleccionarPorTexto(selPrestador, prestadorCodigo);
  await page.getByText('Tipo y Num Identificación').click();
  await selTipoDoc.selectOption(parametros.tipo_doc);
  await page.getByPlaceholder('Número documento').fill(parametros.num_doc);
  await ctx.capturar('01-busqueda');

  // Botón de lupa junto al documento. VERIFICAR: si no es un botón con título, se dispara con Enter.
  const lupa = page.locator('a[title*="Buscar" i], button[title*="Buscar" i], input[type="image"][title*="Buscar" i], img[title*="Buscar" i]').first();
  if (await lupa.isVisible().catch(() => false)) await lupa.click();
  else await page.getByPlaceholder('Número documento').press('Enter');

  // ---- 2. Compañía y contratos ----------------------------------------------------
  await esperarHabilitado(selCompania, ESPERA);
  await seleccionarPorTexto(selCompania, 'Todas');

  const contratosPanel = page.getByText('Contratos', { exact: true });
  const aparecio = await contratosPanel.waitFor({ timeout: ESPERA }).then(() => true).catch(() => false);
  if (!aparecio) {
    await ctx.capturar('02-sin-contratos');
    const texto = (await page.locator('body').innerText()).toLowerCase();
    if (/no se encontr|no existe|sin resultados|no registra/.test(texto)) {
      throw new ErrorNegocio('PACIENTE_NO_ENCONTRADO', `No se encontró el documento ${parametros.tipo_doc} ${parametros.num_doc} en Sanitas`);
    }
    throw new ErrorPortal('El portal no mostró la lista de contratos tras la búsqueda');
  }

  const opcionesContrato = await page.locator('label, span, td').filter({ hasText: /^(EPS|PAC|PMP|POS)\s*-\s*/ }).allInnerTexts();
  const contratosDisponibles = [...new Set(opcionesContrato.map((t) => t.replace(/\s+/g, ' ').trim()))];
  if (contratosDisponibles.length === 0) throw new ErrorPortal('No se pudieron leer los contratos del paciente');

  const elegido = elegirContrato(contratosDisponibles, parametros.contrato);
  if (!elegido) throw new ErrorNegocio('SIN_CONTRATO', `El paciente no tiene contrato ${parametros.contrato} en Sanitas. Disponibles: ${contratosDisponibles.join(' | ')}`);
  if (contratosDisponibles.length > 1) observaciones.push(`Paciente con ${contratosDisponibles.length} contratos; se consultó: ${elegido}`);

  await page.getByText(elegido, { exact: false }).first().click();
  await ctx.capturar('02-contratos');
  await page.getByText('Continuar', { exact: true }).click();

  // ---- 3. Ficha del paciente ------------------------------------------------------
  await page.getByText('Información usuario').waitFor({ timeout: ESPERA });
  await ctx.capturar('03-ficha');
  const ficha = await leerPares(page, [
    'Compañía', 'Plan', 'Contrato', 'Familia', 'Número de Usuario', 'Estado', 'Tipo Documento',
    'Número Documento', 'Teléfono principal', 'Segundo Teléfono', 'Correo electrónico', 'Fecha Nacimiento', 'Edad', 'Sexo',
  ]);
  const nombre = await leerNombre(page);

  // ---- 4. Servicios con autorización ---------------------------------------------
  await page.getByText('Servicios con Autorización').click();
  const tabla = page.locator('table').filter({ hasText: /N[uú]mero Autorizaci[oó]n/i }).first();
  const hayTabla = await tabla.waitFor({ timeout: ESPERA }).then(() => true).catch(() => false);
  await ctx.capturar('04-autorizaciones');

  const autorizaciones = hayTabla ? await leerTablaAutorizaciones(tabla, parametros.fecha_cita) : [];
  if (autorizaciones.length === 0) observaciones.push('El paciente no tiene autorizaciones registradas para este prestador');

  // ---- 5. Selección y copago ------------------------------------------------------
  let seleccionada: Autorizacion | null = null;
  let copago: ResultadoSanitas['copago'] = null;
  if (autorizaciones.length > 0) {
    seleccionada = elegirAutorizacion(autorizaciones, parametros.cups);
    if (parametros.cups && seleccionada.cups !== parametros.cups) {
      observaciones.push(`Ninguna autorización cubre el CUPS ${parametros.cups}; se muestra la más reciente vigente`);
    }
    const fila = tabla.locator('tr').filter({ hasText: seleccionada.numero }).first();
    await fila.locator('input[type="radio"], img, a').first().click(); // VERIFICAR: control de selección en la primera celda
    const apareceCopago = await page.getByText(/N[uú]mero de Autorizaci[oó]n\s*Seleccionada/i).waitFor({ timeout: ESPERA }).then(() => true).catch(() => false);
    if (apareceCopago) {
      const pares = await leerPares(page, ['Condiciones de pago', 'Recaudo de pago', 'Porcentaje Copago', 'Valor pesos pago compartido', 'Tope máximo copagos']);
      copago = {
        condicion: pares['Condiciones de pago'],
        valor_recaudo: aNumero(pares['Recaudo de pago']),
        porcentaje_copago: aNumero(pares['Porcentaje Copago']),
        valor_pago_compartido: aNumero(pares['Valor pesos pago compartido']),
        tope_maximo: aNumero(pares['Tope máximo copagos']),
      };
    } else {
      observaciones.push('El portal no mostró el bloque de copago al seleccionar la autorización');
    }
    await ctx.capturar('05-copago');
  }

  const resultado: ResultadoSanitas = {
    paciente: {
      nombre,
      tipo_doc: parametros.tipo_doc,
      num_doc: parametros.num_doc,
      estado_afiliacion: ficha['Estado'],
      compania: ficha['Compañía'],
      plan: ficha['Plan'],
      contrato: ficha['Contrato'],
      familia: ficha['Familia'],
      telefono: ficha['Teléfono principal'] || ficha['Segundo Teléfono'],
      correo: ficha['Correo electrónico'],
      fecha_nacimiento: aFechaIso(ficha['Fecha Nacimiento']),
      edad: ficha['Edad'],
      sexo: ficha['Sexo'],
    },
    contrato_consultado: elegido,
    contratos_disponibles: contratosDisponibles,
    autorizaciones,
    autorizacion_seleccionada: seleccionada,
    copago,
    semaforo: 'ROJO',
    observaciones,
  };
  resultado.semaforo = calcularSemaforo(resultado, parametros);
  log(`Semáforo ${resultado.semaforo} para ${parametros.tipo_doc} ${parametros.num_doc}`);
  return resultado;
}

// ---------------------------------------------------------------------------------
// Utilidades del flujo
// ---------------------------------------------------------------------------------

async function seleccionarPorTexto(select: Locator, texto: string): Promise<void> {
  await select.waitFor({ timeout: ESPERA });
  const valor = await select.locator('option').filter({ hasText: texto }).first().getAttribute('value');
  if (valor === null) throw new ErrorPortal(`No existe la opción "${texto}" en el combo`);
  await select.selectOption(valor);
}

async function esperarHabilitado(loc: Locator, timeout: number): Promise<void> {
  await loc.waitFor({ timeout });
  const limite = Date.now() + timeout;
  while (Date.now() < limite) {
    if (await loc.isEnabled()) return;
    await loc.page().waitForTimeout(250);
  }
  throw new ErrorPortal('El combo de compañía no se habilitó tras la búsqueda');
}

function elegirContrato(disponibles: string[], preferencia: ParametrosSanitas['contrato']): string | null {
  const eps = disponibles.find((c) => /^EPS\b/i.test(c));
  const pac = disponibles.find((c) => /^PAC\b/i.test(c));
  if (preferencia === 'EPS') return eps ?? null;
  if (preferencia === 'PAC') return pac ?? null;
  return eps ?? pac ?? disponibles[0] ?? null;
}

/**
 * Lee pares "Etiqueta: valor" del DOM: busca el elemento cuyo texto empieza por la etiqueta y toma el siguiente.
 * El código va como texto porque, bajo tsx/esbuild, una función con constantes internas llega al
 * navegador con un helper __name que allí no existe.
 */
const CODIGO_LEER_PARES = `(labels) => {
  const limpiar = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const nodos = Array.from(document.querySelectorAll('td, th, span, label, div, b, strong'));
  const salida = {};
  for (const label of labels) {
    salida[label] = null;
    const nodo = nodos.find((n) => n.children.length === 0 && limpiar(n.textContent).replace(/:$/, '').toLowerCase().startsWith(label.toLowerCase()));
    if (!nodo) continue;
    const propio = limpiar(nodo.textContent);
    const enLinea = propio.includes(':') ? limpiar(propio.split(':').slice(1).join(':')) : '';
    if (enLinea) { salida[label] = enLinea; continue; }
    let sig = nodo.nextElementSibling ?? (nodo.parentElement ? nodo.parentElement.nextElementSibling : null);
    while (sig && !limpiar(sig.textContent)) sig = sig.nextElementSibling;
    salida[label] = sig ? limpiar(sig.textContent) : null;
  }
  return salida;
}`;
async function leerPares(page: Page, etiquetas: string[]): Promise<Record<string, string | null>> {
  return page.evaluate(`(${CODIGO_LEER_PARES})(${JSON.stringify(etiquetas)})`) as Promise<Record<string, string | null>>;
}

async function leerNombre(page: Page): Promise<string | null> {
  const texto = await page.locator('body').innerText();
  const lineas = texto.split('\n').map((l) => l.trim());
  const i = lineas.findIndex((l) => /^Informaci[oó]n usuario/i.test(l));
  const candidata = lineas.slice(i + 1).find((l) => /^[A-ZÁÉÍÓÚÑ_ ]+,[A-ZÁÉÍÓÚÑ_ ]+$/.test(l));
  return candidata ? candidata.replace(/_/g, ' ').replace(/\s*,\s*/, ', ') : null;
}

async function leerTablaAutorizaciones(tabla: Locator, fechaCita?: string): Promise<Autorizacion[]> {
  const filas = await tabla.evaluate((t) =>
    Array.from(t.querySelectorAll('tr')).map((tr) => Array.from(tr.querySelectorAll('td')).map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())),
  );
  const hoy = new Date().toISOString().slice(0, 10);
  const salida: Autorizacion[] = [];
  for (const celdas of filas) {
    const textoFila = celdas.join(' | ');
    // Fila principal: contiene un número de autorización de 6+ dígitos y una fecha dd/mm/aaaa.
    const numero = celdas.find((c) => /^\d{6,}$/.test(c));
    if (numero && /\d{2}\/\d{2}\/\d{4}/.test(textoFila)) {
      const fechas = celdas.filter((c) => /^\d{2}\/\d{2}\/\d{4}$/.test(c));
      const estado = celdas.find((c) => /^(APROBADA|ANULADA|VENCIDA|UTILIZADA|PENDIENTE|RECHAZADA|NEGADA)$/i.test(c)) ?? '';
      const cantidad = celdas.slice().reverse().find((c) => /^\d{1,3}$/.test(c));
      const vigencia = aFechaIso(fechas[1] ?? null);
      salida.push({
        numero,
        tipo: celdas[celdas.indexOf(numero) + 1] ?? '',
        fecha_aprobacion: aFechaIso(fechas[0] ?? null),
        fecha_vigencia: vigencia,
        estado: estado.toUpperCase(),
        prestador: celdas.find((c) => /S\.?A\.?S|LTDA|IPS|CLINICA|CENTRO/i.test(c)) ?? '',
        cups: null,
        descripcion: null,
        cantidad: cantidad ? Number(cantidad) : null,
        vigente_hoy: /APROBADA/i.test(estado) && (vigencia === null || vigencia >= hoy),
        vigente_en_cita: fechaCita ? /APROBADA/i.test(estado) && (vigencia === null || vigencia >= fechaCita) : null,
      });
      continue;
    }
    // Fila de detalle: código CUPS de 6 dígitos + descripción, pertenece a la última autorización leída.
    const ultima = salida[salida.length - 1];
    const cups = celdas.find((c) => /^\d{6}$/.test(c));
    if (ultima && cups) {
      ultima.cups = cups;
      ultima.descripcion = celdas.find((c) => c !== cups && /[A-Za-z]{4,}/.test(c))?.replace(/\s*-\s*[\d.,]+\s*UVR$/i, '') ?? null;
    }
  }
  return salida;
}

function elegirAutorizacion(lista: Autorizacion[], cups?: string): Autorizacion {
  const vigentes = lista.filter((a) => a.vigente_hoy);
  const porCups = cups ? vigentes.find((a) => a.cups === cups) ?? lista.find((a) => a.cups === cups) : undefined;
  if (porCups) return porCups;
  const ordenadas = [...(vigentes.length ? vigentes : lista)].sort((a, b) => (b.fecha_aprobacion ?? '').localeCompare(a.fecha_aprobacion ?? ''));
  return ordenadas[0];
}

function calcularSemaforo(r: ResultadoSanitas, p: ParametrosSanitas): ResultadoSanitas['semaforo'] {
  const activo = /VIGENTE|ACTIVO/i.test(r.paciente.estado_afiliacion ?? '');
  if (!activo) return 'ROJO';
  const a = r.autorizacion_seleccionada;
  if (!a) return 'ROJO';
  const vigente = p.fecha_cita ? a.vigente_en_cita === true : a.vigente_hoy;
  if (!vigente) return 'ROJO';
  if (p.cups && a.cups !== p.cups) return 'AMARILLO';
  if (r.contratos_disponibles.length > 1 && p.contrato === 'AUTO') return 'AMARILLO';
  return 'VERDE';
}

function aFechaIso(ddmmaaaa: string | null | undefined): string | null {
  if (!ddmmaaaa) return null;
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(ddmmaaaa.trim());
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ddmmaaaa.trim());
  return iso ? ddmmaaaa.trim() : null;
}

function aNumero(texto: string | null | undefined): number | null {
  if (!texto) return null;
  const limpio = texto.replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  const n = Number(limpio);
  return Number.isFinite(n) ? n : null;
}
