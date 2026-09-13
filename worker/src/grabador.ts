/**
 * Grabador de acciones: abre el portal con la sesión del cliente en una ventana
 * visible y registra lo que la persona hace (clics, texto, listas, Enter) como
 * pasos de un flujo. Un clic con Alt crea un paso `leer`; Ctrl+Shift+S, `capturar`.
 * La grabación termina con el botón "Detener" de la barra flotante, desde la
 * consola, o al cerrar la ventana.
 */
import { Cliente, Grabacion, Flujo, moduloDesdeFlujo, type ClienteDoc, type FlujoDef, type FlujoDoc, type GrabacionDoc } from '@startia/core';
import type { BrowserContext, Page } from 'playwright';
import { asegurarSesion } from './sesionHelper.js';
import { guardarSesion, obtenerContexto } from './navegador.js';
import { CODIGO_SUGERENCIAS } from './sugerencias.js';

const MAX_MINUTOS = 45;

/** Código del grabador que corre en cada página del portal. Usa window.__startiaGrabar (binding del worker). */
export const CODIGO_GRABADOR = `(() => {
  if (window.__startiaGrabando) return;
  window.__startiaGrabando = true;
  ${CODIGO_SUGERENCIAS}
  const enviar = (p) => { try { window.__startiaGrabar(p); } catch (e) {} };
  const textual = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|number|date|password|email|tel|search|url|)$/.test((el.getAttribute('type') || '').toLowerCase())));
  const accionable = (el) => el.closest('a, button, input, select, textarea, label, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [onclick], td, th, li, span, div') || el;
  // Para campos y listas, el nombre sale de su etiqueta o placeholder (no del texto de las opciones).
  const tituloDe = (el, verbo) => {
    const t = el.tagName.toLowerCase();
    const nombre = t === 'select' || t === 'input' || t === 'textarea'
      ? (etiquetaDe(el) || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || el.id || t)
      : (textoVisible(el) || el.getAttribute('value') || el.getAttribute('title') || el.getAttribute('aria-label') || t);
    return verbo + ' ' + limpiar(nombre).slice(0, 40);
  };
  const conEnter = new WeakSet();

  // Etiqueta para un paso "leer": texto antes de ":" o celda/elemento anterior corto.
  const etiquetaLectura = (el) => {
    const propio = limpiar(el.textContent);
    if (propio.includes(':')) { const e = limpiar(propio.split(':')[0]); if (e.length > 0 && e.length <= 40) return e; }
    let ant = el.previousElementSibling;
    while (ant && !limpiar(ant.textContent)) ant = ant.previousElementSibling;
    if (!ant && el.parentElement) { ant = el.parentElement.previousElementSibling; while (ant && !limpiar(ant.textContent)) ant = ant.previousElementSibling; }
    const e = ant ? limpiar(ant.textContent).replace(/:$/, '') : '';
    return e.length > 0 && e.length <= 40 ? e : '';
  };

  document.addEventListener('click', (e) => {
    if (e.target.closest && e.target.closest('#__startia_barra')) return;
    const el = accionable(e.target);
    if (!el || !el.tagName) return;
    const t = el.tagName.toLowerCase();
    if (e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const etiqueta = etiquetaLectura(el);
      const s = sugerir(el);
      const paso = etiqueta ? { tipo: 'leer', guardar_como: etiqueta.toLowerCase().replace(/[^a-z0-9áéíóúñ]+/g, '_').replace(/^_|_$/g, ''), etiqueta } : { tipo: 'leer', guardar_como: 'valor', objetivo: s[0] || { texto: limpiar(el.textContent).slice(0, 60), exacto: true } };
      paso.titulo = 'Leer ' + (etiqueta || limpiar(el.textContent).slice(0, 40));
      if (s.length) paso.alternativas = s.slice(0, 4);
      enviar(paso);
      return;
    }
    if (t === 'select' || textual(el)) return;
    if (t === 'label' && el.control && (textual(el.control) || el.control.tagName === 'SELECT')) return;
    if (t === 'label' && el.control && (el.control.type === 'radio' || el.control.type === 'checkbox')) {
      const s = sugerir(el.control);
      if (s.length) enviar({ tipo: 'clic', objetivo: s[0], alternativas: s.slice(1, 4), titulo: tituloDe(el, 'Marcar') });
      return;
    }
    const s = sugerir(el);
    if (!s.length) return;
    enviar({ tipo: 'clic', objetivo: s[0], alternativas: s.slice(1, 4), titulo: tituloDe(el, 'Clic en') });
  }, true);

  document.addEventListener('change', (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;
    const t = el.tagName.toLowerCase();
    if (t === 'select') {
      const op = el.options[el.selectedIndex];
      const s = sugerir(el);
      if (s.length) enviar({ tipo: 'seleccionar', objetivo: s[0], alternativas: s.slice(1, 4), texto: limpiar(op ? op.text : ''), valor_opcion: op ? op.value : '', titulo: tituloDe(el, 'Elegir en') + ': ' + limpiar(op ? op.text : '') });
      return;
    }
    if (textual(el)) {
      if (conEnter.has(el)) { conEnter.delete(el); return; }
      const s = sugerir(el);
      if (s.length) enviar({ tipo: 'escribir', objetivo: s[0], alternativas: s.slice(1, 4), valor: el.value, titulo: tituloDe(el, 'Escribir en') });
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); enviar({ tipo: 'capturar', nombre: 'captura', titulo: 'Captura de pantalla' }); return; }
    if (e.key === 'Enter' && textual(e.target)) {
      const el = e.target;
      const s = sugerir(el);
      if (s.length) { enviar({ tipo: 'escribir', objetivo: s[0], alternativas: s.slice(1, 4), valor: el.value, tecla: 'Enter', titulo: tituloDe(el, 'Escribir en') + ' y Enter' }); conEnter.add(el); }
    }
  }, true);

  // Barra flotante con el contador y el botón para terminar.
  const pintarBarra = () => {
    if (document.getElementById('__startia_barra') || !document.body) return;
    const b = document.createElement('div');
    b.id = '__startia_barra';
    b.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;background:#0f7b86;color:#fff;font:13px/1.3 "Segoe UI",system-ui,sans-serif;border-radius:8px;padding:8px 10px;box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;gap:10px;align-items:center';
    b.innerHTML = '<span style="width:9px;height:9px;border-radius:50%;background:#ff5a5a;display:inline-block"></span><span id="__startia_n">Grabando StartIA · 0 pasos</span><small style="opacity:.85">Alt+clic = leer · Ctrl+Shift+S = captura</small><button id="__startia_fin" style="background:#fff;color:#0f7b86;border:0;border-radius:6px;padding:4px 10px;font-weight:700;cursor:pointer">Detener</button>';
    document.body.appendChild(b);
    document.getElementById('__startia_fin').addEventListener('click', (e) => { e.stopPropagation(); enviar({ tipo: 'fin' }); });
  };
  window.__startiaContador = (n) => { pintarBarra(); const s = document.getElementById('__startia_n'); if (s) s.textContent = 'Grabando StartIA · ' + n + ' pasos'; };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pintarBarra); else pintarBarra();
})();`;

type PasoGrabado = Record<string, unknown> & { tipo: string };

/** Sustituye valores de prueba por plantillas {{parametro}} y limpia campos internos. */
export function normalizarPaso(paso: PasoGrabado, parametros: Record<string, unknown>): PasoGrabado {
  const p: PasoGrabado = { ...paso };
  const nombreDe = (valor: unknown) => Object.entries(parametros).find(([, v]) => v !== '' && v !== undefined && String(v) === String(valor))?.[0];
  if (p.tipo === 'escribir' && typeof p.valor === 'string') {
    const n = nombreDe(p.valor);
    if (n) p.valor = `{{${n}}}`;
  }
  if (p.tipo === 'seleccionar') {
    const n = nombreDe(p.valor_opcion) ?? nombreDe(p.texto);
    if (n) {
      p.valor = `{{${n}}}`;
      delete p.texto;
    }
    delete p.valor_opcion;
  }
  if (p.tipo === 'capturar') p.nombre = `grabada-${Date.now().toString(36)}`;
  return p;
}

const contextosConBinding = new WeakSet<BrowserContext>();
let grabacionActiva: { id: GrabacionDoc['_id']; n: number; fin: boolean; parametros: Record<string, unknown> } | null = null;

/** Toma una grabación solicitada. Solo workers con ventana visible. */
export async function reclamarGrabacion(workerId: string): Promise<GrabacionDoc | null> {
  return Grabacion.findOneAndUpdate(
    { estado: 'solicitada', detener: { $ne: true } },
    { $set: { estado: 'grabando', workerId, iniciadaEn: new Date() } },
    { sort: { createdAt: 1 }, new: true },
  ).lean<GrabacionDoc>();
}

export async function grabar(g: GrabacionDoc, log: (m: string) => void): Promise<void> {
  const id = g._id;
  const terminar = async (estado: 'terminada' | 'fallida' | 'cancelada', error?: string) => {
    await Grabacion.updateOne({ _id: id }, { $set: { estado, terminadaEn: new Date(), ...(error ? { error } : {}) } });
  };
  const cliente = await Cliente.findOne({ slug: g.clienteSlug }).lean<ClienteDoc>();
  if (!cliente) return terminar('fallida', `No existe el cliente ${g.clienteSlug}`);

  // Sesión: se usa la definición del flujo (borrador o publicada) para saber si hay sesión e intentar el login.
  const flujo = g.flujoNombre ? await Flujo.findOne({ nombre: g.flujoNombre }).lean<FlujoDoc>() : null;
  const def = (flujo?.borrador ?? flujo?.definicion ?? null) as FlujoDef | null;
  const modulo = def ? moduloDesdeFlujo(def, flujo?.version ?? 0) : null;
  const credCifradas = ((cliente.credenciales as Record<string, Record<string, string>>)?.[g.portal] ?? {});
  const { descifrar } = await import('@startia/core');
  const credenciales = Object.fromEntries(Object.entries(credCifradas).map(([k, v]) => [k, descifrar(v)]));

  const ctx = await obtenerContexto(cliente.slug, g.portal, false);
  grabacionActiva = { id, n: 0, fin: false, parametros: (g.parametrosPrueba ?? {}) as Record<string, unknown> };
  if (!contextosConBinding.has(ctx)) {
    await ctx.exposeBinding('__startiaGrabar', async (_fuente, paso: PasoGrabado) => {
      const activa = grabacionActiva;
      if (!activa || !paso || typeof paso.tipo !== 'string') return;
      if (paso.tipo === 'fin') {
        activa.fin = true;
        return;
      }
      const normal = normalizarPaso(paso, activa.parametros);
      activa.n++;
      await Grabacion.updateOne({ _id: activa.id }, { $push: { pasos: normal } }).catch(() => undefined);
      log(`grabación ${String(activa.id).slice(-6)}: paso ${activa.n} ${normal.tipo}${normal.titulo ? ` · ${normal.titulo}` : ''}`);
    });
    await ctx.addInitScript(CODIGO_GRABADOR);
    contextosConBinding.add(ctx);
  }

  const page: Page = ctx.pages()[0] ?? (await ctx.newPage());
  try {
    await page.goto(g.urlInicio, { waitUntil: 'domcontentloaded' });
    if (modulo) {
      await asegurarSesion(modulo, ctx, page, credenciales, { headless: false, log, clienteSlug: cliente.slug });
    }
    // La página actual ya cargó antes del init script: se inyecta ahora. Las siguientes lo reciben solas.
    await page.evaluate(CODIGO_GRABADOR).catch(() => undefined);
    await page.bringToFront().catch(() => undefined);
    log(`Grabando en ${g.portal} para ${cliente.slug}. Termine con "Detener" en la barra de la ventana o desde la consola.`);

    const limite = Date.now() + MAX_MINUTOS * 60_000;
    let cerrada = false;
    page.on('close', () => (cerrada = true));
    while (!grabacionActiva.fin && !cerrada && Date.now() < limite) {
      await new Promise((r) => setTimeout(r, 1500));
      // Latido: la consola sabe que este worker sigue atendiendo la grabación.
      const doc = await Grabacion.findOneAndUpdate({ _id: id }, { $set: { ultimaSenal: new Date() } }, { new: true }).select('detener').lean<{ detener?: boolean }>();
      if (doc?.detener) break;
      for (const p of ctx.pages()) await p.evaluate(`window.__startiaContador && window.__startiaContador(${grabacionActiva.n})`).catch(() => undefined);
    }
    await guardarSesion(cliente.slug, g.portal, ctx, 'manual').catch(() => undefined);
    for (const p of ctx.pages()) await p.evaluate("const b = document.getElementById('__startia_barra'); if (b) b.remove(); window.__startiaGrabando = false;").catch(() => undefined);
    await terminar('terminada');
    log(`Grabación terminada con ${grabacionActiva.n} pasos`);
  } catch (e) {
    await terminar('fallida', (e as Error).message);
    log(`Grabación falló: ${(e as Error).message}`);
  } finally {
    grabacionActiva = null;
  }
}
