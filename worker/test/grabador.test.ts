/**
 * Prueba del grabador de acciones contra el portal falso: inyecta el código del
 * grabador en un navegador sin ventana, ejecuta acciones con Playwright (que
 * disparan los mismos eventos que una persona) y comprueba los pasos grabados.
 *
 * Uso: npm run test:grabador
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { CODIGO_GRABADOR, normalizarPaso } from '../src/grabador.js';

const url = pathToFileURL(resolve(process.cwd(), 'core/test/portal-falso.html')).href;
const navegador = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const ctx = await navegador.newContext();
const grabados: Array<Record<string, unknown> & { tipo: string }> = [];
await ctx.exposeBinding('__startiaGrabar', (_f, paso: Record<string, unknown> & { tipo: string }) => void grabados.push(paso));
await ctx.addInitScript(CODIGO_GRABADOR);
const page = await ctx.newPage();

try {
  await page.goto(url);
  assert.ok(await page.locator('#__startia_barra').isVisible(), 'la barra flotante debe aparecer');

  await page.selectOption('#prestador', { label: '176805 - CLINICA PRUEBA' });
  await page.click('label:has-text("Tipo y Num Identificación")');
  await page.fill('#doc', '79589789');
  await page.press('#doc', 'Enter');
  await page.click('button[title="Buscar"]');
  await page.waitForTimeout(400);
  await page.selectOption('#compania', 'T');
  await page.click('label:has-text("EPS - 1389266")');
  await page.click('text=Continuar');
  await page.click('#ficha table tr:nth-child(3) td:nth-child(2)', { modifiers: ['Alt'] }); // Alt+clic sobre "VIGENTE"
  await page.keyboard.press('Control+Shift+S');
  await page.click('#__startia_fin');
  await page.waitForTimeout(300);

  const tipos = grabados.map((p) => p.tipo);
  console.log('pasos grabados:', tipos.join(', '));
  assert.deepEqual(tipos, ['seleccionar', 'clic', 'escribir', 'clic', 'seleccionar', 'clic', 'clic', 'leer', 'capturar', 'fin']);

  const [sel, radio, doc, buscar, comp, contrato, continuar, leer] = grabados;
  assert.deepEqual(sel.objetivo, { selector: '#prestador' });
  assert.equal(sel.texto, '176805 - CLINICA PRUEBA');
  assert.deepEqual(radio.objetivo, { etiqueta: 'Tipo y Num Identificación' });
  assert.deepEqual(doc.objetivo, { selector: '#doc' });
  assert.equal(doc.valor, '79589789');
  assert.equal(doc.tecla, 'Enter');
  assert.deepEqual(buscar.objetivo, { rol: 'button', nombre: 'Buscar' });
  assert.deepEqual(comp.objetivo, { selector: '#compania' });
  assert.equal(comp.texto, 'Todas');
  assert.deepEqual(contrato.objetivo, { etiqueta: 'EPS - 1389266' }, 'radio dentro de un label: por etiqueta');
  assert.deepEqual(continuar.objetivo, { rol: 'button', nombre: 'Continuar' });
  assert.equal(leer.tipo, 'leer');
  assert.equal(leer.etiqueta, 'Estado');
  assert.equal(leer.guardar_como, 'estado');
  console.log('ok  acciones grabadas con objetivos estables');

  // Un solo "escribir" para el documento: el Enter no lo duplica con el change posterior.
  assert.equal(tipos.filter((t) => t === 'escribir').length, 1);
  console.log('ok  escribir + Enter sin duplicar');

  // Valores de prueba → plantillas.
  const n = normalizarPaso(doc as never, { num_doc: '79589789', tipo_doc: 'CC' });
  assert.equal(n.valor, '{{num_doc}}');
  const s = normalizarPaso({ tipo: 'seleccionar', objetivo: { selector: '#tipo' }, texto: 'CC', valor_opcion: 'CC' }, { tipo_doc: 'CC' });
  assert.equal(s.valor, '{{tipo_doc}}');
  assert.equal(s.texto, undefined);
  assert.equal(s.valor_opcion, undefined);
  console.log('ok  valores de prueba convertidos a parámetros');

  console.log('\nTodas las pruebas del grabador pasaron.');
} finally {
  await navegador.close();
}
