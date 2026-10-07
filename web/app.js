const $ = (id) => document.getElementById(id);
const chat = $("chat");
const input = $("input");
const send = $("send");

let sessionId = localStorage.getItem("sessionId") || "";
let ultimosPendientes = {};

function headers() {
  const h = { "Content-Type": "application/json" };
  const clave = localStorage.getItem("accessKey");
  if (clave) h["x-access-key"] = clave;
  return h;
}

async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, { ...opciones, headers: headers() });
  if (res.status === 401) {
    const clave = prompt("Este agente requiere clave de acceso:");
    if (clave) {
      localStorage.setItem("accessKey", clave);
      return api(ruta, opciones);
    }
  }
  return res;
}

function markdown(texto) {
  if (window.marked && window.DOMPurify) return window.DOMPurify.sanitize(window.marked.parse(texto));
  // Si la librería de Markdown no cargó (sin internet), se muestra el texto tal cual, respetando saltos de línea.
  const pre = document.createElement("pre");
  pre.style.whiteSpace = "pre-wrap";
  pre.textContent = texto;
  return pre.outerHTML;
}

function quitarVacio() {
  $("vacio")?.remove();
}

function agregar(el) {
  quitarVacio();
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
  return el;
}

function pintarUsuario(texto) {
  const div = document.createElement("div");
  div.className = "msg usuario";
  const p = document.createElement("p");
  p.textContent = texto;
  div.appendChild(p);
  agregar(div);
}

function pintarAgente(texto, pide) {
  const div = document.createElement("div");
  div.className = `msg agente${pide ? " pide" : ""}`;
  div.innerHTML = markdown(texto);
  agregar(div);
}

function pintarError(texto) {
  const div = document.createElement("div");
  div.className = "msg error";
  div.textContent = texto;
  agregar(div);
}

function contenedorTraza() {
  const ultimo = chat.lastElementChild;
  if (ultimo?.classList.contains("traza")) return ultimo;
  const div = document.createElement("div");
  div.className = "traza";
  return agregar(div);
}

function bonito(texto) {
  try {
    return JSON.stringify(JSON.parse(texto), null, 2);
  } catch {
    return texto;
  }
}

function pintarHerramienta(h) {
  const d = document.createElement("details");
  const espera = /^(requiere revisión|requiere confirmación|confirmación bloqueada)/.test(h.resumen);
  if (!h.ok) d.classList.add(espera ? "espera" : "fallo");
  const s = document.createElement("summary");
  s.innerHTML = `<span class="punto" aria-hidden="true"></span><span class="nombre"></span><span class="resumen"></span>`;
  s.querySelector(".nombre").textContent = h.nombre;
  s.querySelector(".resumen").textContent = h.resumen;
  const pre = document.createElement("pre");
  pre.textContent = `argumentos\n${JSON.stringify(h.argumentos, null, 2)}\n\nresultado\n${bonito(h.resultado)}`;
  d.append(s, pre);
  contenedorTraza().appendChild(d);
  chat.scrollTop = chat.scrollHeight;
}

function pintarPendientes(pendientes) {
  ultimosPendientes = pendientes || {};
  const ids = Object.keys(ultimosPendientes);
  $("confirmar").hidden = ids.length === 0;
  const ul = $("pendientes");
  ul.innerHTML = "";
  for (const id of ids) {
    const li = document.createElement("li");
    const titulo = document.createElement("strong");
    titulo.textContent = id;
    const campos = document.createElement("ul");
    for (const c of ultimosPendientes[id]) {
      const item = document.createElement("li");
      item.textContent = `${c.campo}: ${JSON.stringify(c.valor_propuesto)} — ${c.motivo}`;
      campos.appendChild(item);
    }
    li.append(titulo, campos);
    ul.appendChild(li);
  }
}

function pintarVista(vista) {
  for (const item of vista) {
    if (item.tipo === "usuario") pintarUsuario(item.texto);
    else if (item.tipo === "agente") pintarAgente(item.texto, item.confirmacion);
    else if (item.tipo === "error") pintarError(item.texto);
    else if (item.tipo === "herramienta") pintarHerramienta(item);
  }
}

async function enviar(texto) {
  if (!texto.trim()) return;
  pintarUsuario(texto);
  input.value = "";
  send.disabled = true;
  const pensando = agregar(Object.assign(document.createElement("p"), { className: "pensando", textContent: "Procesando…" }));
  const inicio = Date.now();
  const reloj = setInterval(() => (pensando.textContent = `Procesando… ${Math.round((Date.now() - inicio) / 1000)} s`), 1000);
  try {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ sessionId, message: texto }) });
    const data = await res.json();
    pensando.remove();
    if (data.sessionId) {
      sessionId = data.sessionId;
      localStorage.setItem("sessionId", sessionId);
    }
    if (data.model) $("estado").textContent = `Modelo: ${data.model}`;
    for (const h of data.toolCalls || []) pintarHerramienta(h);
    if (data.error && data.error !== "tope_tokens" && data.reply) pintarError(data.reply);
    else if (data.reply) pintarAgente(data.reply, data.needsConfirmation);
    else if (data.error) pintarError(data.error);
    pintarPendientes(data.pending);
  } catch (err) {
    pensando.remove();
    pintarError(`No hubo respuesta del servidor: ${err.message}. Revisa la conexión y vuelve a enviar.`);
  } finally {
    clearInterval(reloj);
    send.disabled = false;
    input.focus();
  }
}

async function cargar() {
  try {
    const h = await (await fetch("/api/health")).json();
    const respaldo = h.respaldo?.length ? ` · respaldo: ${h.respaldo.join(", ")}` : "";
    $("estado").textContent = h.model ? `Modelo: ${h.provider}/${h.model}${respaldo}` : "Sin proveedor de modelo configurado";
    $("estado").classList.toggle("sin", !h.model);
  } catch {
    $("estado").textContent = "Servidor no disponible";
    $("estado").classList.add("sin");
  }
  if (!sessionId) return;
  const res = await api(`/api/sessions/${sessionId}`);
  if (!res.ok) {
    sessionId = "";
    localStorage.removeItem("sessionId");
    return;
  }
  const s = await res.json();
  pintarVista(s.vista);
  pintarPendientes(s.pendientes);
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  enviar(input.value);
});
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    enviar(input.value);
  }
});
document.querySelectorAll(".sugerencia").forEach((b) => b.addEventListener("click", () => enviar(b.dataset.texto)));
$("btn-confirmar").addEventListener("click", () => {
  const ids = Object.keys(ultimosPendientes).join(", ");
  enviar(`Confirmo los valores propuestos para ${ids}.`);
});
$("nueva").addEventListener("click", () => {
  localStorage.removeItem("sessionId");
  location.reload();
});
$("reset").addEventListener("click", async () => {
  if (!confirm("Esto borra out/ (maestro, historial y procesados) para repetir la demo. ¿Continuar?")) return;
  await api("/api/reset", { method: "POST" });
  localStorage.removeItem("sessionId");
  location.reload();
});

// ---------- Reporte (alertas, maestro, acuses) ----------

const formato = (v, moneda) => (v === 0 ? "por demanda" : `${moneda} ${Number(v).toLocaleString("es-CO")}`);

function celda(fila, texto, clase) {
  const td = document.createElement("td");
  td.textContent = texto;
  if (clase) td.className = clase;
  fila.appendChild(td);
}

function pintarMaestro(filas) {
  const cont = $("pestana-maestro");
  cont.innerHTML = "";
  const tabla = document.createElement("table");
  tabla.innerHTML = "<thead><tr><th>Contrato</th><th>Cliente</th><th>Valor</th><th>Inicio</th><th>Fin</th><th>Póliza</th><th>Comercial</th></tr></thead>";
  const cuerpo = document.createElement("tbody");
  for (const r of filas) {
    const tr = document.createElement("tr");
    celda(tr, r.id_contrato);
    celda(tr, r.cliente);
    celda(tr, formato(r.valor, r.moneda), "num");
    celda(tr, r.fecha_inicio);
    celda(tr, r.fecha_fin);
    celda(tr, r.requiere_poliza ? r.estado_poliza : "no aplica", `estado-${r.estado_poliza}`);
    celda(tr, r.comercial);
    cuerpo.appendChild(tr);
  }
  tabla.appendChild(cuerpo);
  cont.appendChild(tabla);
}

function pintarAcuses(acuses) {
  const cont = $("pestana-acuses");
  cont.innerHTML = "";
  if (!acuses.length) {
    cont.innerHTML = '<p class="vacio-reporte">Todavía no hay acuses. Se redactan cuando el agente procesa cada mensaje del buzón.</p>';
    return;
  }
  for (const a of acuses) {
    const pre = document.createElement("pre");
    pre.textContent = a.contenido;
    cont.appendChild(pre);
  }
}

async function cargarReporte(hoy) {
  const res = await api(`/api/reporte${hoy ? `?hoy=${hoy}` : ""}`);
  const data = await res.json();
  if (!res.ok) {
    $("pestana-alertas").innerHTML = "";
    $("pestana-alertas").append(Object.assign(document.createElement("p"), { className: "vacio-reporte", textContent: data.error }));
    return;
  }
  $("pestana-alertas").innerHTML = data.alertas
    ? markdown(data.alertas)
    : '<p class="vacio-reporte">Aún no hay reporte de alertas. Elige la fecha de referencia y pulsa "Actualizar alertas".</p>';
  pintarMaestro(data.maestro);
  pintarAcuses(data.acuses);
}

document.querySelectorAll(".pestanas button").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll(".pestanas button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    for (const nombre of ["alertas", "maestro", "acuses"]) $(`pestana-${nombre}`).hidden = nombre !== b.dataset.pestana;
  }),
);
$("ver-reporte").addEventListener("click", async () => {
  $("reporte").showModal();
  await cargarReporte();
});
$("cerrar-reporte").addEventListener("click", () => $("reporte").close());
$("form-reporte").addEventListener("submit", async (e) => {
  e.preventDefault();
  await cargarReporte($("hoy").value);
});

cargar();
input.focus();
