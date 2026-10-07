import { REGLAS, type Moneda, type Pais } from "./reglas";
import { letrasANumero, parseCifra } from "./numeros";
import { normalizeText } from "./similarity";
import { MES_RE, buscarFecha, isoValida, mesANumero, sumarDias, sumarMeses, ultimoDiaDelMes } from "./fechas";

export type TipoDocumento = "contrato" | "contrato_marco" | "otrosi" | "cotizacion" | "desconocido";

export const CAMPOS = [
  "id_contrato",
  "cliente",
  "nit_cliente",
  "pais",
  "objeto",
  "valor",
  "moneda",
  "fecha_inicio",
  "fecha_fin",
  "requiere_poliza",
  "tipo_poliza",
] as const;
export type Campo = (typeof CAMPOS)[number];

export type ContratoExtraido = {
  tipo_documento: TipoDocumento;
  id_contrato: string | null;
  cliente: string | null;
  nit_cliente: string | null;
  pais: Pais | null;
  objeto: string | null;
  valor: number | null;
  moneda: Moneda | null;
  valor_indeterminado: boolean;
  fecha_inicio: string | null;
  fecha_fin: string | null;
  requiere_poliza: boolean | null;
  tipo_poliza: string | null;
  /** Solo en otrosíes: el documento ordena ampliar las garantías existentes. */
  ampliar_garantias: boolean;
  /** Confianza por campo en [0, 1]. Campo ausente = 0. */
  confianza: Record<Campo, number>;
  /** Observaciones legibles que el agente puede mostrar (condiciones, supuestos, inconsistencias). */
  notas: string[];
  /** Por qué un campo tiene confianza baja, en palabras de la analista. */
  motivos: Partial<Record<Campo, string>>;
};

export class ErrorExtraccion extends Error {}

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function detectarTipo(texto: string): TipoDocumento {
  const primera = texto.trim().split(/\r?\n/)[0]?.toUpperCase() ?? "";
  if (/^OTROS[IÍ]/.test(primera)) return "otrosi";
  if (/COTIZACI[OÓ]N/.test(primera)) return "cotizacion";
  if (/CONTRATO MARCO/.test(primera)) return "contrato_marco";
  if (/CONTRATO/.test(primera)) return "contrato";
  return "desconocido";
}

export function esDocumentoContractual(tipo: TipoDocumento): boolean {
  return tipo === "contrato" || tipo === "contrato_marco" || tipo === "otrosi";
}

/** Texto de una cláusula: "SEGUNDA. VALOR. ..." hasta el siguiente salto de línea. */
function clausula(texto: string, titulo: string): string | null {
  const m = new RegExp(`\\b[A-ZÁÉÍÓÚ]+\\.\\s*${titulo}\\.\\s*([^\\n]+)`, "i").exec(texto);
  return m ? m[1].trim() : null;
}

/** En un otrosí, el nuevo texto de una cláusula modificada: (PLAZO) ... "nuevo texto". */
function clausulaModificada(texto: string, titulo: string): string | null {
  const m = new RegExp(`\\(${titulo}\\)[^"\\n]*"([^"]+)"`, "i").exec(texto);
  return m ? m[1].trim() : null;
}

// ---------- Partes ----------

type Parte = { nombre: string; tipoId: string; idRaw: string; esContratante: boolean };

function partes(texto: string): Parte[] {
  const re = /([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ0-9.&\s]+?),\s*(?:identificad[ao] con\s+)?(NIT|RUC|RTN)\s+([\d.\-]+)/g;
  const encontrados: { nombre: string; tipoId: string; idRaw: string; fin: number; inicio: number }[] = [];
  for (const m of texto.matchAll(re)) {
    encontrados.push({ nombre: m[1].trim(), tipoId: m[2].toUpperCase(), idRaw: m[3].replace(/[.\-]$/, ""), inicio: m.index ?? 0, fin: (m.index ?? 0) + m[0].length });
  }
  return encontrados.map((p, i) => {
    const hasta = encontrados[i + 1]?.inicio ?? texto.length;
    const tramo = texto.slice(p.fin, hasta).toUpperCase();
    return { nombre: p.nombre, tipoId: p.tipoId, idRaw: p.idRaw, esContratante: tramo.includes("CONTRATANTE") };
  });
}

function limpiarId(tipoId: string, raw: string): string {
  // NIT colombiano: sin puntos y sin dígito de verificación.
  if (tipoId === "NIT") return raw.replace(/-\d$/, "").replace(/\D/g, "");
  return raw.replace(/\D/g, "");
}

/** Busca la razón social con mayúsculas/minúsculas en el bloque de firmas. */
function nombreDesdeFirmas(texto: string, nombreMayus: string): string | null {
  const objetivo = normalizeText(nombreMayus);
  for (const linea of texto.split(/\r?\n/)) {
    for (const celda of linea.split(/\s{2,}/)) {
      const c = celda.trim();
      if (c && c !== c.toUpperCase() && normalizeText(c) === objetivo) return c;
    }
  }
  return null;
}

function titulo(s: string): string {
  return s
    .toLowerCase()
    .replace(/(^|\s)(\p{L})/gu, (_m, esp: string, l: string) => esp + l.toUpperCase())
    .replace(/\b(De|Del|La|Los|Las|Y)\b/g, (w) => w.toLowerCase())
    .replace(/S\.a\.s\./gi, "S.A.S.")
    .replace(/S\.a\.c\./gi, "S.A.C.")
    .replace(/S\.a\./gi, "S.A.");
}

const PAIS_POR_TEXTO: [RegExp, Pais][] = [
  [/ecuador|quito|guayaquil/i, "EC"],
  [/per[uú]\b|lima\b/i, "PE"],
  [/panam[aá]/i, "PA"],
  [/honduras|tegucigalpa|san pedro sula/i, "HN"],
  [/colombia|bogot[aá]|medell[ií]n|barranquilla|cali\b|cartagena|bucaramanga/i, "CO"],
];

function paisPorId(tipoId: string, raw: string, limpio: string): Pais | null {
  if (tipoId === "NIT" && /-\d$/.test(raw)) return "CO";
  if (tipoId === "RUC" && limpio.length === 13 && limpio.endsWith("001")) return "EC";
  if (tipoId === "RUC" && limpio.length === 11) return "PE";
  if (tipoId === "RTN" || limpio.length === 14) return "HN";
  return null;
}

function paisPorDomicilio(tramoParte: string): Pais | null {
  const dom = /domicilio en ([^,(]+(?:,\s*[A-ZÁÉÍÓÚ][^,(]+)?)/i.exec(tramoParte)?.[1] ?? "";
  for (const [re, pais] of PAIS_POR_TEXTO) if (re.test(dom)) return pais;
  return null;
}

// ---------- Campos ----------

function extraerId(texto: string): { valor: string | null; conf: number } {
  const titulo1 = texto.trim().split(/\r?\n/)[0] ?? "";
  const m = /No\.?\s*([A-Z]{2,4}-\d{4}-\d+)/i.exec(titulo1);
  if (m) return { valor: m[1].toUpperCase(), conf: 1 };
  const enTexto = /contrato\s+No\.?\s*([A-Z]{2,4}-\d{4}-\d+)/i.exec(texto);
  if (enTexto) return { valor: enTexto[1].toUpperCase(), conf: 0.85 };
  return { valor: null, conf: 0 };
}

function extraerObjeto(texto: string): { valor: string | null; conf: number } {
  const c = clausula(texto, "OBJETO");
  if (!c) return { valor: null, conf: 0 };
  let obj = c.replace(/^EL CONTRATISTA\s+(?:se obliga a\s+|prestar[aá]\s+(?:el\s+)?)/i, "").replace(/\.$/, "");
  obj = obj.charAt(0).toUpperCase() + obj.slice(1);
  if (obj.length > 200) obj = `${obj.slice(0, 197).replace(/\s+\S*$/, "")}...`;
  return { valor: obj, conf: 0.95 };
}

type Valor = { valor: number | null; moneda: Moneda | null; indeterminado: boolean; confValor: number; confMoneda: number; notas: string[]; motivo?: string };

function extraerValor(texto: string, tipo: TipoDocumento): Valor {
  const c = tipo === "otrosi" ? clausulaModificada(texto, "VALOR") : clausula(texto, "VALOR");
  if (!c) return { valor: null, moneda: null, indeterminado: false, confValor: 0, confMoneda: 0, notas: [] };
  if (/no tiene un valor determinado|valor indeterminado|por demanda/i.test(c)) {
    return {
      valor: 0,
      moneda: null,
      indeterminado: true,
      confValor: 0.6,
      confMoneda: 0,
      notas: ["Valor por demanda: el contrato no fija valor total; se registra 0 con valor_indeterminado = true."],
      motivo: "contrato por demanda sin valor total; se propone 0",
    };
  }
  const m = /((?:[A-ZÁÉÍÓÚÑ/]+\s+)+)\(\s*([A-Z]{3})\s*\$?\s*([\d.,]+)\s*\)/.exec(c);
  if (!m) return { valor: null, moneda: null, indeterminado: false, confValor: 0, confMoneda: 0, notas: ["No se encontró el valor en cifras."] };
  const codigo = m[2];
  if (!(REGLAS.monedas as readonly string[]).includes(codigo)) {
    throw new ErrorExtraccion(`moneda desconocida: ${codigo}`);
  }
  const moneda = codigo as Moneda;
  const cifra = parseCifra(m[3], moneda);
  const letras = letrasANumero(m[1]);
  const notas: string[] = [];
  let confValor = 0.85;
  if (cifra !== null && letras !== null) {
    if (letras === cifra) confValor = 1;
    else {
      confValor = 0.5;
      notas.push(`El valor en letras (${letras}) no coincide con el valor en cifras (${cifra}).`);
      return { valor: cifra, moneda, indeterminado: false, confValor, confMoneda: 1, notas, motivo: `letras (${letras}) y cifras (${cifra}) no coinciden` };
    }
  }
  if (/IVA incluido|incluidos los impuestos/i.test(c)) notas.push("Valor con impuestos incluidos.");
  if (/m[aá]s (?:el IVA|los impuestos)/i.test(c)) notas.push("Valor antes de impuestos.");
  return { valor: cifra, moneda, indeterminado: false, confValor: cifra === null ? 0 : confValor, confMoneda: 1, notas };
}

type Plazo = { inicio: string | null; fin: string | null; confInicio: number; confFin: number; notas: string[]; motivo?: string };

function fechaFirma(texto: string): { iso: string | null; soloMes: { y: number; m: number } | null } {
  const completa = new RegExp(`\\((\\d{1,2})\\)\\s+d[ií]as del mes de ${MES_RE} de (\\d{4})`, "i").exec(texto);
  if (completa) return { iso: isoValida(Number(completa[3]), mesANumero(completa[2]) ?? 0, Number(completa[1])), soloMes: null };
  const mes = new RegExp(`en el mes de ${MES_RE} de (\\d{4})`, "i").exec(texto);
  if (mes) return { iso: null, soloMes: { y: Number(mes[2]), m: mesANumero(mes[1]) ?? 0 } };
  return { iso: null, soloMes: null };
}

function extraerPlazo(texto: string, tipo: TipoDocumento): Plazo {
  const c = tipo === "otrosi" ? clausulaModificada(texto, "PLAZO") : clausula(texto, "PLAZO");
  if (!c) return { inicio: null, fin: null, confInicio: 0, confFin: 0, notas: [] };
  const notas: string[] = [];
  if (/prorrogables? autom[aá]ticamente/i.test(c)) notas.push("Prórroga automática salvo aviso con antelación.");
  const meses = /\((\d+)\)\s+meses/i.exec(c);
  const n = meses ? Number(meses[1]) : null;

  // Otrosí: solo cambia la fecha final.
  const extiende = /se extiende hasta el (.+?\d{4})/i.exec(c);
  if (extiende) {
    const f = buscarFecha(extiende[1]);
    if (f.invalida) throw new ErrorExtraccion(`fecha inválida en el plazo: "${extiende[1]}"`);
    return { inicio: null, fin: f.iso, confInicio: 0, confFin: f.iso ? 0.95 : 0, notas };
  }

  // Rango explícito "desde ... hasta ...".
  const rango = /desde el (.+?\d{4}).*?hasta el (.+?\d{4})/i.exec(c);
  if (rango) {
    const a = buscarFecha(rango[1]);
    const b = buscarFecha(rango[2]);
    if (a.invalida || b.invalida) throw new ErrorExtraccion(`fecha inválida en el plazo: "${c.slice(0, 120)}"`);
    let confFin = b.iso ? 0.95 : 0;
    let confInicio = a.iso ? 0.95 : 0;
    if (a.iso && b.iso && n !== null) {
      const esperado = sumarDias(sumarMeses(a.iso, n), -1);
      if (esperado === b.iso) {
        confFin = 1;
        confInicio = 1;
      } else {
        confFin = 0.6;
        notas.push(`El plazo dice ${n} meses pero las fechas dan otro rango (fin esperado ${esperado}).`);
        return { inicio: a.iso, fin: b.iso, confInicio, confFin, notas, motivo: `el plazo de ${n} meses no cuadra con las fechas (esperado ${esperado})` };
      }
    }
    return { inicio: a.iso, fin: b.iso, confInicio, confFin, notas };
  }

  // Plazo en meses contado desde la firma.
  if (n !== null && /a partir de la fecha de su firma|desde la firma/i.test(c)) {
    const firma = fechaFirma(texto);
    if (firma.iso) {
      return {
        inicio: firma.iso,
        fin: sumarDias(sumarMeses(firma.iso, n), -1),
        confInicio: 0.85,
        confFin: 0.75,
        notas: [...notas, `Plazo de ${n} meses desde la firma (${firma.iso}).`],
        motivo: `fecha fin calculada: ${n} meses desde la firma`,
      };
    }
    if (firma.soloMes) {
      const { y, m } = firma.soloMes;
      const inicio = isoValida(y, m, 1);
      const finMes = new Date(Date.UTC(y, m - 1 + n, 1));
      const fin = ultimoDiaDelMes(finMes.getUTCFullYear(), finMes.getUTCMonth() + 1);
      notas.push(
        `Firma sin día (solo mes). Propuesta: inicio ${inicio} y fin ${fin}, al cierre del mes, para cubrir cualquier día de firma. Requiere confirmación.`,
      );
      return { inicio, fin, confInicio: 0.5, confFin: 0.5, notas, motivo: `firmado "en el mes de" sin día; plazo de ${n} meses desde la firma` };
    }
    notas.push(`Plazo de ${n} meses desde la firma, pero no se encontró la fecha de firma.`);
  }
  return { inicio: null, fin: null, confInicio: 0, confFin: 0, notas };
}

type Poliza = { requiere: boolean | null; tipos: string | null; conf: number; ampliar: boolean; notas: string[] };

function extraerPoliza(texto: string, tipo: TipoDocumento): Poliza {
  const tiposDe = (s: string): string[] => {
    const t = s.toLowerCase();
    const out: string[] = [];
    if (/cumplimiento/.test(t)) out.push("cumplimiento");
    if (/calidad/.test(t)) out.push("calidad");
    if (/salarios/.test(t)) out.push("salarios_prestaciones");
    if (/responsabilidad civil/.test(t)) out.push("responsabilidad_civil");
    return out;
  };
  if (tipo === "otrosi") {
    const ampliar = /garant[ií]as[^.]*deber[aá]n ampliarse/i.test(texto);
    return {
      requiere: null,
      tipos: null,
      conf: 0,
      ampliar,
      notas: ampliar ? ["El otrosí exige ampliar la vigencia de las garantías: la póliza queda pendiente de actualización."] : [],
    };
  }
  const c = clausula(texto, "GARANT[IÍ]AS");
  if (!c) {
    const menciona = /p[oó]liza/i.test(texto);
    return { requiere: false, tipos: "", conf: menciona ? 0.6 : 0.9, ampliar: false, notas: menciona ? ["Menciona pólizas fuera de una cláusula de garantías."] : [] };
  }
  const tipos = tiposDe(c);
  const notas: string[] = [];
  const pct = /(\d+)%\)?\s*del valor/i.exec(c);
  if (pct) notas.push(`Póliza por el ${pct[1]}% del valor.`);
  const condicional = /para cada orden de servicio cuyo valor supere/i.test(c);
  if (condicional) notas.push("Póliza condicional: solo para órdenes de servicio que superen el umbral del contrato.");
  return { requiere: tipos.length > 0, tipos: tipos.join(";"), conf: condicional ? 0.85 : 0.95, ampliar: false, notas };
}

// ---------- Orquestación ----------

/** Extrae los campos del texto de un contrato u otrosí. Determinista: no usa el modelo. */
export function extraerContrato(texto: string): ContratoExtraido {
  const limpio = texto.trim();
  if (!limpio) throw new ErrorExtraccion("texto vacío");
  const tipo = detectarTipo(limpio);
  const notas: string[] = [];

  const id = extraerId(limpio);
  const lista = partes(limpio);
  const contratante =
    lista.find((p) => p.esContratante && limpiarId(p.tipoId, p.idRaw) !== REGLAS.nitPropio) ??
    lista.find((p) => limpiarId(p.tipoId, p.idRaw) !== REGLAS.nitPropio) ??
    null;

  let cliente: string | null = null;
  let nit: string | null = null;
  let pais: Pais | null = null;
  let confCliente = 0;
  let confNit = 0;
  let confPais = 0;
  if (contratante) {
    cliente = nombreDesdeFirmas(limpio, contratante.nombre) ?? titulo(contratante.nombre);
    nit = limpiarId(contratante.tipoId, contratante.idRaw);
    confCliente = contratante.esContratante ? 0.95 : 0.8;
    confNit = contratante.esContratante ? 1 : 0.8;
    const idx = limpio.indexOf(contratante.nombre);
    const tramo = limpio.slice(idx, idx + 400);
    const porId = paisPorId(contratante.tipoId, contratante.idRaw, nit);
    const porDom = paisPorDomicilio(tramo);
    pais = porId ?? porDom;
    confPais = porId && porDom ? (porId === porDom ? 1 : 0.5) : pais ? 0.85 : 0;
    if (porId && porDom && porId !== porDom) notas.push(`País inconsistente: el identificador sugiere ${porId} y el domicilio ${porDom}.`);
  }

  const objeto = tipo === "otrosi" ? { valor: null, conf: 0 } : extraerObjeto(limpio);
  const valor = extraerValor(limpio, tipo);
  const plazo = extraerPlazo(limpio, tipo);
  const poliza = extraerPoliza(limpio, tipo);

  let moneda = valor.moneda;
  let confMoneda = valor.confMoneda;
  if (valor.indeterminado && !moneda && pais) {
    moneda = REGLAS.monedaPorPais[pais];
    confMoneda = 0.85;
  }

  return {
    tipo_documento: tipo,
    id_contrato: id.valor,
    cliente,
    nit_cliente: nit,
    pais,
    objeto: objeto.valor,
    valor: valor.valor,
    moneda,
    valor_indeterminado: valor.indeterminado,
    fecha_inicio: plazo.inicio,
    fecha_fin: plazo.fin,
    requiere_poliza: poliza.requiere,
    tipo_poliza: poliza.tipos,
    ampliar_garantias: poliza.ampliar,
    confianza: {
      id_contrato: r2(id.conf),
      cliente: r2(confCliente),
      nit_cliente: r2(confNit),
      pais: r2(confPais),
      objeto: r2(objeto.conf),
      valor: r2(valor.confValor),
      moneda: r2(confMoneda),
      fecha_inicio: r2(plazo.confInicio),
      fecha_fin: r2(plazo.confFin),
      requiere_poliza: r2(poliza.conf),
      tipo_poliza: r2(poliza.conf),
    },
    notas: [...notas, ...valor.notas, ...plazo.notas, ...poliza.notas],
    motivos: {
      ...(valor.motivo ? { valor: valor.motivo } : {}),
      ...(plazo.motivo ? { fecha_inicio: plazo.motivo, fecha_fin: plazo.motivo } : {}),
      ...(confPais === 0.5 ? { pais: "el identificador y el domicilio apuntan a países distintos" } : {}),
    },
  };
}
