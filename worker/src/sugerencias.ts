/**
 * Código que corre dentro de la página para describir un elemento y sugerir
 * objetivos estables (id, etiqueta, placeholder, rol con nombre, texto...).
 * Lo comparten la inspección de capturas y el grabador de acciones.
 *
 * Va como texto, y sin funciones con nombre en su interior, porque bajo tsx/esbuild
 * una función con constantes internas llega al navegador con un helper __name que allí no existe.
 * Define: limpiar, rolDe, etiquetaDe, sugerir(el) y describir(el).
 */
export const CODIGO_SUGERENCIAS = `
  const limpiar = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const rolDe = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'img') return 'img';
    if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return 'button'; if (ty === 'checkbox') return 'checkbox'; if (ty === 'radio') return 'radio'; if (ty === 'hidden') return null; return 'textbox'; }
    if (/^h[1-6]$/.test(t)) return 'heading';
    return null;
  };
  const etiquetaDe = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return limpiar(l.textContent); }
    const p = el.closest('label'); if (p) return limpiar(p.textContent);
    const al = el.getAttribute('aria-label'); if (al) return limpiar(al);
    return '';
  };
  const indiceRolDe = (el, rol) => {
    if (!rol) return undefined;
    const todos = Array.from(document.querySelectorAll('a, button, input, select, textarea, img, [role], h1, h2, h3, h4, h5, h6')).filter((x) => rolDe(x) === rol);
    const i = todos.indexOf(el);
    return i < 0 ? undefined : i;
  };
  const describir = (el) => {
    const t = el.tagName.toLowerCase();
    const rol = rolDe(el);
    const texto = limpiar(t === 'input' || t === 'select' || t === 'textarea' ? (el.getAttribute('value') || el.getAttribute('title') || '') : el.textContent).slice(0, 80);
    const nombre = el.getAttribute('aria-label') || el.getAttribute('title') || (t === 'input' ? '' : texto);
    const etiqueta = (t === 'input' || t === 'select' || t === 'textarea') ? etiquetaDe(el) : '';
    const placeholder = el.getAttribute('placeholder') || '';
    const name = el.getAttribute('name');
    return { t, rol, texto, nombre, etiqueta, placeholder, name, title: el.getAttribute('title') };
  };
  const sugerir = (el) => {
    const d = describir(el);
    const sug = [];
    if (el.id && !/^(j_id|id\\d|:)/.test(el.id) && !/\\d{3,}/.test(el.id)) sug.push({ selector: '#' + CSS.escape(el.id) });
    if (d.etiqueta && (d.t === 'input' || d.t === 'select' || d.t === 'textarea')) sug.push({ etiqueta: d.etiqueta });
    if (d.placeholder) sug.push({ placeholder: d.placeholder });
    if (d.rol && d.nombre && d.rol !== 'textbox' && d.rol !== 'combobox') sug.push({ rol: d.rol, nombre: d.nombre.slice(0, 60) });
    if (d.rol && (d.rol === 'combobox' || d.rol === 'textbox' || d.rol === 'checkbox' || d.rol === 'radio')) { const i = indiceRolDe(el, d.rol); if (i !== undefined) sug.push({ rol: d.rol, indice: i }); }
    if (d.texto && !(d.t === 'input' || d.t === 'select' || d.t === 'textarea')) sug.push({ texto: d.texto.slice(0, 60), exacto: d.texto.length <= 60 });
    if (d.name) sug.push({ selector: d.t + '[name="' + d.name.replace(/"/g, '\\\\"') + '"]' });
    if (d.title) sug.push({ selector: d.t + '[title="' + d.title.replace(/"/g, '\\\\"') + '"]' });
    return sug;
  };
`;
