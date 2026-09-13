/**
 * Prueba del intérprete de flujos contra un portal falso (core/test/portal-falso.html)
 * que imita la estructura del Validador Sanitas: formulario, contratos, ficha con
 * pares etiqueta/valor, tabla de autorizaciones con filas de detalle y bloque de copago.
 *
 * Ejecuta el mismo JSON de flujos/sanitas-autorizaciones.json, cambiando solo la URL
 * de inicio y la sesión, y comprueba el resultado. No necesita Mongo ni credenciales.
 *
 * Uso: npm run test:flujos
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { ErrorNegocio, FlujoDefSchema, moduloDesdeFlujo, plantilla, leerRuta, escribirRuta, aNumero, aFechaIso, type FlujoDef } from '../src/index.js';

const aqui = resolve(process.cwd(), 'core/test');
const urlPortal = pathToFileURL(resolve(aqui, 'portal-falso.html')).href;

// ---- Utilidades puras -----------------------------------------------------------
{
  const vars = { num_doc: '79', lista: [1, 2, 3], ficha: { estado: 'VIGENTE' } };
  assert.equal(plantilla('Doc {{num_doc}}', vars), 'Doc 79');
  assert.equal(plantilla('{{fecha_de_afiliación}}', { 'fecha_de_afiliación': '2026-01-02' }), '2026-01-02', 'variables con tilde de flujos grabados antes');
  assert.deepEqual(plantilla('{{lista}}', vars), [1, 2, 3]);
  assert.equal(plantilla('{{lista.-1}}', vars), 3);
  assert.deepEqual(plantilla({ a: '{{ficha.estado}}', b: ['{{num_doc}}'] }, vars), { a: 'VIGENTE', b: ['79'] });
  const obj: Record<string, unknown> = { lista: [{ n: 1 }] };
  escribirRuta(obj, 'lista.-1.cups', '890328');
  assert.equal(leerRuta(obj, 'lista.0.cups'), '890328');
  escribirRuta(obj, 'copago.valor', 5);
  assert.deepEqual(obj.copago, { valor: 5 });
  assert.equal(aNumero('$ 5.000'), 5000);
  assert.equal(aNumero('12,5'), 12.5);
  assert.equal(aFechaIso('02/12/2026'), '2026-12-02');
  console.log('ok  utilidades puras');
}

// ---- Flujo de Sanitas contra el portal falso ------------------------------------
const crudo = JSON.parse(await readFile(resolve(process.cwd(), 'flujos/sanitas-autorizaciones.json'), 'utf8'));
const def: FlujoDef = FlujoDefSchema.parse({
  ...crudo,
  url_inicio: urlPortal,
  sesion: { valida_si: { texto_visible: 'Validación - búsqueda de Usuario' } },
});
const modulo = moduloDesdeFlujo(def, 1);

const chromiumPath = process.env.CHROMIUM_PATH;
const navegador = await chromium.launch({ headless: true, executablePath: chromiumPath || undefined });

async function correr(parametros: Record<string, unknown>) {
  const page = await navegador.newPage();
  const capturas: string[] = [];
  try {
    await page.goto(urlPortal);
    assert.equal(await modulo.sesionValida(page), true, 'sesionValida debe reconocer la página');
    const val = modulo.parametros.safeParse(parametros);
    assert.ok(val.success, 'parámetros válidos: ' + JSON.stringify(val.success ? null : val.error.issues));
    return await modulo.ejecutar({
      parametros: val.data as Record<string, unknown>,
      credenciales: {},
      config: { prestadorCodigo: '176805' },
      page,
      capturar: async (n) => void capturas.push(n),
      log: () => undefined,
    });
  } finally {
    await page.close();
  }
}

try {
  // Caso 1: paciente con dos contratos, CUPS cubierto, autorización vigente → AMARILLO por contrato AUTO con varios contratos.
  const r1 = (await correr({ num_doc: '79589789', cups: '890328' })) as Record<string, any>;
  assert.equal(r1.paciente.nombre, 'BELTRAN RODRIGUEZ, EDSON AUGUSTO');
  assert.equal(r1.paciente.estado_afiliacion, 'VIGENTE');
  assert.equal(r1.paciente.plan, '10 REGIMEN CONTRIBUTIVO');
  assert.equal(r1.paciente.telefono, '3001234567', 'telefono cae al segundo cuando el principal está vacío');
  assert.equal(r1.paciente.fecha_nacimiento, '1980-03-05');
  assert.deepEqual(r1.contratos_disponibles, ['PAC - 555', 'EPS - 1389266']);
  assert.equal(r1.contrato_consultado, 'EPS - 1389266', 'AUTO prefiere EPS');
  assert.equal(r1.autorizaciones.length, 2);
  assert.equal(r1.autorizaciones[0].numero, '333983714');
  assert.equal(r1.autorizaciones[0].cups, '890328');
  assert.equal(r1.autorizaciones[0].descripcion, 'CONSULTA DE CONTROL POR CARDIOLOGIA');
  assert.equal(r1.autorizaciones[0].fecha_vigencia, '2026-12-02');
  assert.equal(r1.autorizaciones[0].vigente_hoy, true);
  assert.equal(r1.autorizaciones[0].cantidad, 1);
  assert.equal(r1.autorizaciones[1].estado, 'VENCIDA');
  assert.equal(r1.autorizaciones[1].vigente_hoy, false);
  assert.equal(r1.autorizacion_seleccionada.numero, '333983714');
  assert.equal(r1.copago.condicion, 'Cuota Moderadora');
  assert.equal(r1.copago.valor_recaudo, 5000);
  assert.equal(r1.semaforo, 'AMARILLO');
  assert.ok(r1.observaciones.some((o: string) => o.includes('2 contratos')));
  console.log('ok  caso 1: consulta completa, semáforo AMARILLO por varios contratos');

  // Caso 2: contrato EPS explícito y CUPS cubierto → VERDE.
  const r2 = (await correr({ num_doc: '79589789', cups: '890328', contrato: 'EPS' })) as Record<string, any>;
  assert.equal(r2.semaforo, 'VERDE');
  assert.ok(!r2.observaciones.some((o: string) => o.includes('CUPS')), 'sin observación de CUPS cuando está cubierto');
  console.log('ok  caso 2: contrato EPS explícito, semáforo VERDE');

  // Caso 3: CUPS no cubierto → se muestra la vigente más reciente y semáforo AMARILLO con observación.
  const r3 = (await correr({ num_doc: '79589789', cups: '999999', contrato: 'EPS' })) as Record<string, any>;
  assert.equal(r3.autorizacion_seleccionada.numero, '333983714');
  assert.equal(r3.semaforo, 'AMARILLO');
  assert.ok(r3.observaciones.some((o: string) => o.includes('999999')));
  console.log('ok  caso 3: CUPS no cubierto, semáforo AMARILLO');

  // Caso 4: fecha de cita posterior a la vigencia → ROJO.
  const r4 = (await correr({ num_doc: '79589789', contrato: 'EPS', fecha_cita: '2027-01-15' })) as Record<string, any>;
  assert.equal(r4.autorizaciones[0].vigente_en_cita, false);
  assert.equal(r4.semaforo, 'ROJO');
  console.log('ok  caso 4: cita fuera de vigencia, semáforo ROJO');

  // Caso 5: paciente inexistente → error de negocio PACIENTE_NO_ENCONTRADO.
  await assert.rejects(correr({ num_doc: '0000' }), (e: unknown) => e instanceof ErrorNegocio && e.codigo === 'PACIENTE_NO_ENCONTRADO');
  console.log('ok  caso 5: paciente inexistente → PACIENTE_NO_ENCONTRADO');

  // Caso 6: parámetros inválidos los rechaza el esquema generado.
  assert.equal(modulo.parametros.safeParse({ num_doc: 'abc' }).success, false);
  assert.equal(modulo.parametros.safeParse({ num_doc: '123456', cups: '12' }).success, false);
  console.log('ok  caso 6: validación de parámetros');

  console.log('\nTodas las pruebas del intérprete pasaron.');
} finally {
  await navegador.close();
}
