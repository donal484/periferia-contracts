import type { ToolCtx } from "./paths";
import { REGLAS } from "./reglas";
import type { MaestroRow } from "./csv";
import { leerAdjunto, leerCorreo, readMaestro, resolverComercial, type Correo } from "./io";
import { CAMPOS, ErrorExtraccion, detectarTipo, esDocumentoContractual, extraerContrato, type Campo, type ContratoExtraido, type TipoDocumento } from "./extraction";
import type { ContratoPropuesta } from "./esquemas";
import { jaccardSimilarity } from "./similarity";
import { esIso } from "./fechas";

export type Clasificacion = "nuevo" | "actualizacion" | "duplicado" | "rechazado";

export type DetalleRevision = { campo: Campo; valor_propuesto: unknown; confianza: number; motivo: string };

export type Evaluacion = {
  mensaje_id: string;
  clasificacion: Clasificacion;
  motivo?: string;
  adjunto: string | null;
  tipo_documento: TipoDocumento | null;
  contrato: ContratoExtraido | null;
  id_contrato_existente?: string;
  fila_existente?: MaestroRow;
  requiere_revision: Campo[];
  detalle_revision: DetalleRevision[];
  diferencias?: Partial<Record<keyof MaestroRow, { antes: unknown; despues: unknown }>>;
  comercial: { nombre: string; email: string; conocido: boolean };
  notas: string[];
  /** Valores que la analista cambió frente al documento al confirmar (para el historial). */
  correcciones: Partial<Record<Campo, { documento: unknown; analista: unknown }>>;
};

/** Campos que un otrosí o un reenvío pueden modificar. El objeto y las partes no se comparan (cambia la redacción, no el contrato). */
const CAMPOS_COMPARABLES: (Campo & keyof MaestroRow)[] = ["valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza"];

/** Busca en los adjuntos el primero que sea un contrato, contrato marco u otrosí (por contenido, no por nombre de archivo). */
export async function buscarDocumento(ctx: ToolCtx, correo: Correo): Promise<{ adjunto: string; texto: string; tipo: TipoDocumento } | { rechazo: string }> {
  if (correo.adjuntos.length === 0) return { rechazo: "el correo no trae adjuntos" };
  const vistos: string[] = [];
  for (const adj of correo.adjuntos) {
    const texto = await leerAdjunto(ctx, correo.id, adj);
    if (texto === null) {
      vistos.push(`${adj} (no encontrado)`);
      continue;
    }
    if (!texto.trim()) throw new ErrorExtraccion(`texto vacío en el adjunto ${adj}`);
    const tipo = detectarTipo(texto);
    if (esDocumentoContractual(tipo)) return { adjunto: adj, texto, tipo };
    vistos.push(`${adj} (${tipo === "cotizacion" ? "cotización" : "documento no contractual"})`);
  }
  return { rechazo: `sin adjunto de contrato: ${vistos.join(", ")}` };
}

function iguales(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 0.005;
  return String(a ?? "") === String(b ?? "");
}

/** Aplica los valores propuestos. Si difieren del documento, bajan la confianza (salvo que la analista ya confirmó). */
function aplicarPropuesta(
  c: ContratoExtraido,
  p: ContratoPropuesta | undefined,
  confirmado: boolean,
  motivos: Map<Campo, string>,
  correcciones: Evaluacion["correcciones"],
): ContratoExtraido {
  if (!p) return c;
  const out: ContratoExtraido = { ...c, confianza: { ...c.confianza }, notas: [...c.notas], motivos: { ...c.motivos } };
  for (const campo of CAMPOS) {
    const v = p[campo];
    if (v === undefined || v === null || iguales(v, c[campo])) continue;
    if ((campo === "fecha_inicio" || campo === "fecha_fin") && typeof v === "string" && !esIso(v)) {
      throw new ErrorExtraccion(`fecha inválida en ${campo}: ${v}`);
    }
    Object.assign(out, { [campo]: v });
    if (confirmado) {
      out.confianza[campo] = 1;
      correcciones[campo] = { documento: c[campo], analista: v };
      out.notas.push(`${campo} corregido por la analista: ${String(c[campo])} → ${String(v)}.`);
    } else {
      out.confianza[campo] = 0.4;
      motivos.set(campo, `valor propuesto (${String(v)}) distinto al documento (${String(c[campo])})`);
    }
  }
  if (p.valor_indeterminado !== undefined && p.valor_indeterminado !== null) out.valor_indeterminado = p.valor_indeterminado;
  if (out.valor_indeterminado) out.valor = 0;
  return out;
}

function camposEnRevision(c: ContratoExtraido, campos: Campo[], motivos: Map<Campo, string>): DetalleRevision[] {
  return campos
    .filter((campo) => c.confianza[campo] < REGLAS.umbralConfianza)
    .map((campo) => ({
      campo,
      valor_propuesto: c[campo],
      confianza: c.confianza[campo],
      motivo: motivos.get(campo) ?? c.motivos[campo] ?? (c[campo] === null ? "no aparece en el documento" : `confianza ${c.confianza[campo]} menor a ${REGLAS.umbralConfianza}`),
    }));
}

function diferenciasCon(fila: MaestroRow, c: ContratoExtraido, campos: (Campo & keyof MaestroRow)[]): Partial<Record<keyof MaestroRow, { antes: unknown; despues: unknown }>> {
  const diffs: Partial<Record<keyof MaestroRow, { antes: unknown; despues: unknown }>> = {};
  for (const campo of campos) {
    const nuevo = c[campo];
    if (nuevo === null || nuevo === undefined) continue;
    if (!iguales(nuevo, fila[campo])) diffs[campo] = { antes: fila[campo], despues: nuevo };
  }
  return diffs;
}

/**
 * Núcleo de RN1–RN5. Lo usan `contratos_validar` y `contratos_registrar`, así que
 * lo que se registra siempre es exactamente lo que se validó.
 * Lanza ErrorExtraccion para los errores de HU-6 (texto vacío, fecha inválida, moneda desconocida).
 */
export async function evaluar(ctx: ToolCtx, mensajeId: string, propuesta?: ContratoPropuesta, confirmado = false): Promise<Evaluacion> {
  const correo = await leerCorreo(ctx, mensajeId);
  if (!correo) throw new ErrorExtraccion(`mensaje no encontrado: ${mensajeId}`);
  const comercialInfo = await resolverComercial(ctx, correo.de);
  const comercial = { ...comercialInfo, email: correo.de };
  const notas: string[] = comercial.conocido ? [] : [`Remitente no registrado en comerciales.json (${correo.de}). Se reporta, no bloquea.`];
  const correcciones: Evaluacion["correcciones"] = {};
  const base = { mensaje_id: mensajeId, comercial, requiere_revision: [] as Campo[], detalle_revision: [] as DetalleRevision[], correcciones };

  const doc = await buscarDocumento(ctx, correo);
  if ("rechazo" in doc) {
    return { ...base, clasificacion: "rechazado", motivo: doc.rechazo, adjunto: null, tipo_documento: null, contrato: null, notas };
  }

  const motivos = new Map<Campo, string>();
  const c = aplicarPropuesta(extraerContrato(doc.texto), propuesta, confirmado, motivos, correcciones);
  const comun = { ...base, adjunto: doc.adjunto, tipo_documento: doc.tipo, contrato: c, notas: [...notas, ...c.notas] };
  const maestro = await readMaestro(ctx);

  // ---- Otrosí: siempre modifica un contrato existente (RN2) ----
  if (doc.tipo === "otrosi") {
    const fila = maestro.find((r) => r.id_contrato === c.id_contrato);
    if (!fila) {
      return { ...comun, clasificacion: "rechazado", motivo: `otrosí del contrato ${c.id_contrato ?? "(sin número)"}, que no está en el maestro` };
    }
    const diferencias = diferenciasCon(fila, c, CAMPOS_COMPARABLES);
    if (c.ampliar_garantias && fila.requiere_poliza && fila.estado_poliza !== "pendiente") {
      diferencias.estado_poliza = { antes: fila.estado_poliza, despues: "pendiente" };
    }
    const revisar = Object.keys(diferencias).filter((k): k is Campo => (CAMPOS as readonly string[]).includes(k));
    if (c.nit_cliente && c.nit_cliente !== fila.nit_cliente) {
      motivos.set("nit_cliente", `el otrosí trae ${c.nit_cliente} y el maestro ${fila.nit_cliente}`);
      c.confianza.nit_cliente = 0.3;
      revisar.push("nit_cliente");
    }
    const detalle = camposEnRevision(c, revisar, motivos);
    if (Object.keys(diferencias).length === 0) {
      return { ...comun, clasificacion: "duplicado", motivo: "el otrosí no cambia nada frente al maestro", id_contrato_existente: fila.id_contrato, fila_existente: fila };
    }
    return { ...comun, clasificacion: "actualizacion", id_contrato_existente: fila.id_contrato, fila_existente: fila, diferencias, requiere_revision: detalle.map((d) => d.campo), detalle_revision: detalle };
  }

  // ---- Contrato o contrato marco ----
  if (!c.cliente && !c.objeto) {
    return { ...comun, clasificacion: "rechazado", motivo: "el texto no contiene partes ni objeto identificables" };
  }

  const porId = c.id_contrato ? maestro.find((r) => r.id_contrato === c.id_contrato) : undefined;
  const porNitObjeto = !porId && c.nit_cliente && c.objeto
    ? maestro.find((r) => r.nit_cliente === c.nit_cliente && jaccardSimilarity(r.objeto, c.objeto ?? "") >= REGLAS.similitudObjeto)
    : undefined;
  const fila = porId ?? porNitObjeto;

  if (fila) {
    const mismo = iguales(fila.valor, c.valor) && fila.fecha_inicio === c.fecha_inicio && fila.fecha_fin === c.fecha_fin;
    if (porId && mismo) {
      return { ...comun, clasificacion: "duplicado", motivo: `${fila.id_contrato} ya está en el maestro con el mismo valor y fechas`, id_contrato_existente: fila.id_contrato, fila_existente: fila };
    }
    const diferencias = diferenciasCon(fila, c, CAMPOS_COMPARABLES);
    const detalle = camposEnRevision(c, Object.keys(diferencias).filter((k): k is Campo => (CAMPOS as readonly string[]).includes(k)), motivos);
    return {
      ...comun,
      clasificacion: "actualizacion",
      id_contrato_existente: fila.id_contrato,
      fila_existente: fila,
      diferencias,
      requiere_revision: detalle.map((d) => d.campo),
      detalle_revision: detalle,
      notas: porNitObjeto ? [...comun.notas, `Coincide con ${fila.id_contrato} por NIT y objeto (similitud ≥ ${REGLAS.similitudObjeto}).`] : comun.notas,
    };
  }

  const relacionados = maestro.filter((r) => r.nit_cliente === c.nit_cliente).map((r) => r.id_contrato);
  const obligatorios = CAMPOS.filter((k) => k !== "tipo_poliza" || c.requiere_poliza === true);
  const detalle = camposEnRevision(c, [...obligatorios], motivos);
  return {
    ...comun,
    clasificacion: "nuevo",
    requiere_revision: detalle.map((d) => d.campo),
    detalle_revision: detalle,
    notas: relacionados.length ? [...comun.notas, `Mismo cliente que ${relacionados.join(", ")}, pero es otro contrato (id y objeto distintos).`] : comun.notas,
  };
}
