/**
 * Utilidades compartidas por la ficha del cliente y el asistente de nueva automatización:
 * identificadores generados a partir de nombres, y los códigos de integración que se
 * entregan al sistema del cliente (URL, clave de API y ejemplos en cURL, JavaScript y Python).
 */
window.StartiaIntegracion = (() => {
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

  // ---------------------------------------------------------------------------------
  // Identificadores
  // ---------------------------------------------------------------------------------
  const VACIAS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'en', 'y', 'a', 'para', 'por', 'un', 'una', 'con', 'al']);
  const palabras = (texto) => String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const recortar = (s, max, sep) => (s.length <= max ? s : s.slice(0, max).replace(new RegExp(`\\${sep}[^\\${sep}]*$`), '') || s.slice(0, max));

  /** "Consultar autorizaciones en Sanitas" → "consultar-autorizaciones-sanitas" */
  function identificador(texto, max = 50) {
    let s = recortar(palabras(texto).filter((w) => !VACIAS.has(w)).join('-'), max, '-');
    if (s && !/^[a-z]/.test(s)) s = 'f-' + s;
    return s;
  }

  /** "Clínica Norte S.A.S." → "clinica-norte" (sin la forma societaria). */
  function identificadorCliente(nombre) {
    const SUFIJOS = ['s a s bic', 'sas bic', 's a s', 'sas', 's a', 'sa', 'ltda', 'limitada', 'e u', 'eu', 'bic'];
    let t = ' ' + palabras(nombre).join(' ');
    for (let cambio = true; cambio; ) {
      cambio = false;
      for (const s of SUFIJOS) if (t.endsWith(' ' + s) && t.length > s.length + 2) { t = t.slice(0, -(s.length + 1)); cambio = true; }
    }
    let s = recortar(t.trim().split(' ').filter(Boolean).join('-'), 40, '-');
    if (s && !/^[a-z]/.test(s)) s = 'c-' + s;
    return s;
  }

  /** "Número de documento" → "numero_documento" */
  function nombreCampo(etiqueta) {
    let s = recortar(palabras(etiqueta).filter((w) => !VACIAS.has(w)).join('_'), 40, '_');
    if (s && !/^[a-z]/.test(s)) s = 'dato_' + s;
    return s;
  }

  /** "https://portal.colsanitas.com/login" → "colsanitas" */
  function portalDesdeUrl(url) {
    let host = '';
    try { host = new URL(url).hostname.toLowerCase(); } catch { return ''; }
    if (!host) return '';
    if (host === 'localhost' || /^[\d.]+$/.test(host)) return 'local';
    const GENERICOS = new Set(['www', 'www2', 'portal', 'portales', 'app', 'apps', 'web', 'login', 'sso', 'auth', 'cas', 'servicios', 'online', 'sitio', 'oficinavirtual', 'virtual', 'transaccional', 'empresas', 'prestadores', 'm', 'secure', 'seguro', 'idp', 'accounts', 'mi']);
    const TLD = new Set(['com', 'co', 'net', 'org', 'gov', 'gob', 'edu', 'io', 'mil', 'info', 'biz', 'us', 'es', 'mx', 'ar', 'pe', 'cl', 'ec', 've', 'br']);
    const partes = host.split('.').filter((x) => !TLD.has(x));
    const utiles = partes.filter((x) => !GENERICOS.has(x));
    return identificador((utiles.length ? utiles[utiles.length - 1] : partes[partes.length - 1]) || '', 30);
  }

  // ---------------------------------------------------------------------------------
  // Códigos de integración
  // ---------------------------------------------------------------------------------
  // Los ejemplos nunca llevan valores de prueba reales (pueden ser datos de pacientes): usan
  // el ejemplo documentado del parámetro o un valor ficticio.
  function valorEjemplo(p) {
    const e = p.ejemplo ?? p.por_defecto;
    if (p.tipo === 'numero') return e !== undefined && e !== '' && !Number.isNaN(Number(e)) ? Number(e) : 12345;
    if (p.tipo === 'booleano') return e === undefined ? true : String(e) === 'true';
    if (p.tipo === 'fecha') return e || new Date().toISOString().slice(0, 10);
    if (p.tipo === 'opcion') { const o = (p.opciones || [])[0]; return e ?? (Array.isArray(o) ? o[0] : o ?? ''); }
    if (e !== undefined && e !== '') return e;
    return /doc|cedula|identific|nit|num/.test(p.nombre) ? '1234567890' : 'valor';
  }

  /** Cuerpo de ejemplo: los parámetros obligatorios o documentados, más modo sync. */
  function cuerpo(parametros) {
    const o = {};
    for (const p of parametros || []) if (p.requerido || p.ejemplo !== undefined) o[p.nombre] = valorEjemplo(p);
    o.modo = 'sync';
    return o;
  }

  const aPython = (json) => json.replace(/"(?:[^"\\]|\\.)*"|\btrue\b|\bfalse\b|\bnull\b/g, (m) => ({ true: 'True', false: 'False', null: 'None' }[m] ?? m));

  /** @param {{ base: string, portal: string, modulo: string, apiKey?: string, parametros?: any[] }} o */
  function ejemplos(o) {
    const url = `${o.base}/v1/${o.portal}/${o.modulo}`;
    const clave = o.apiKey || 'SU_CLAVE_DE_API';
    const body = cuerpo(o.parametros);
    const json = JSON.stringify(body, null, 2);
    return {
      url,
      curl: `curl -X POST "${url}" \\\n  -H "x-api-key: ${clave}" \\\n  -H "content-type: application/json" \\\n  -d '${JSON.stringify(body)}'`,
      javascript: `const respuesta = await fetch("${url}", {\n  method: "POST",\n  headers: { "x-api-key": "${clave}", "content-type": "application/json" },\n  body: JSON.stringify(${json.replace(/\n/g, '\n  ')}),\n});\nconst datos = await respuesta.json();\n// datos.estado: "completado", "pendiente", "en_proceso" o "fallido"\n// datos.resultado: los valores que el robot leyó en el portal\nconsole.log(datos.estado, datos.resultado);`,
      python: `import requests\n\nrespuesta = requests.post(\n    "${url}",\n    headers={"x-api-key": "${clave}"},\n    json=${aPython(json).replace(/\n/g, '\n    ')},\n    timeout=120,\n)\ndatos = respuesta.json()\nprint(datos["estado"], datos["resultado"])`,
    };
  }

  /** Respuesta de ejemplo con la forma real de la API. */
  function respuestaEjemplo({ modulo, parametros, resultado }) {
    const p = cuerpo(parametros);
    delete p.modo;
    const id = '66e4c1f0a9d2b37c5e8f1a42';
    return { id, estado: 'completado', modulo, parametros: p, resultado: resultado ?? {}, error: null, capturas: [], duracion_ms: 42000, estado_url: `/v1/trabajos/${id}` };
  }

  let conEstilos = false;
  function ponerEstilos() {
    if (conEstilos) return;
    conEstilos = true;
    const s = document.createElement('style');
    s.textContent = `.int{border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--paper)}
.int-cab{display:flex;align-items:center;gap:2px;background:var(--paper-2);border-bottom:1px solid var(--line);padding:0 6px}
.int-cab button{background:transparent;border:0;border-bottom:2px solid transparent;border-radius:0;color:var(--muted);padding:8px 12px;font-size:13px}
.int-cab button.act{color:var(--ink);border-bottom-color:var(--accent)}
.int-cab button.copiar{margin-left:auto;border:1px solid var(--line-2);border-radius:6px;padding:3px 10px;font-size:12px;color:var(--accent-ink);background:var(--paper)}
.int pre{margin:0;border:0;border-radius:0;max-height:none;background:var(--paper);padding:12px 14px;font-family:var(--mono);font-size:12.5px;line-height:1.55;overflow-x:auto;white-space:pre}
.int-url{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px}
.int-url code{font-family:var(--mono);font-size:13px;background:var(--paper-2);border:1px solid var(--line);border-radius:6px;padding:5px 9px;word-break:break-all}
.int-metodo{font-family:var(--mono);font-size:11.5px;font-weight:700;background:var(--accent);color:#fff;border-radius:5px;padding:3px 7px}`;
    document.head.appendChild(s);
  }

  async function copiar(texto, boton) {
    try {
      await navigator.clipboard.writeText(texto);
    } catch {
      const t = document.createElement('textarea');
      t.value = texto;
      document.body.appendChild(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    if (boton) { const antes = boton.textContent; boton.textContent = 'Copiado'; setTimeout(() => (boton.textContent = antes), 1400); }
  }

  /** Pinta la URL y los ejemplos con pestañas y botón Copiar dentro de `contenedor`. */
  function pintar(contenedor, o) {
    ponerEstilos();
    const e = ejemplos(o);
    const pestañas = [['curl', 'cURL'], ['javascript', 'JavaScript'], ['python', 'Python']];
    contenedor.innerHTML = `<div class="int-url"><span class="int-metodo">POST</span><code>${esc(e.url)}</code><button type="button" class="mini sec" data-copiar-url>Copiar URL</button></div>
      <div class="int"><div class="int-cab">${pestañas.map(([k, t], i) => `<button type="button" data-k="${k}"${i === 0 ? ' class="act"' : ''}>${t}</button>`).join('')}<button type="button" class="copiar">Copiar</button></div><pre>${esc(e.curl)}</pre></div>`;
    let actual = 'curl';
    const pre = contenedor.querySelector('pre');
    contenedor.querySelectorAll('.int-cab [data-k]').forEach((b) => (b.onclick = () => {
      actual = b.dataset.k;
      pre.textContent = e[actual];
      contenedor.querySelectorAll('.int-cab [data-k]').forEach((x) => x.classList.toggle('act', x === b));
    }));
    contenedor.querySelector('.copiar').onclick = (ev) => copiar(e[actual], ev.currentTarget);
    contenedor.querySelector('[data-copiar-url]').onclick = (ev) => copiar(e.url, ev.currentTarget);
    return e;
  }

  return { identificador, identificadorCliente, nombreCampo, portalDesdeUrl, cuerpo, ejemplos, respuestaEjemplo, pintar, copiar };
})();
