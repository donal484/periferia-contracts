import type { Moneda, Pais } from "./reglas";

export type EstadoPoliza = "vigente" | "pendiente" | "vencida" | "no_aplica";
export type Fuente = "buzon" | "manual" | "migracion";

export type MaestroRow = {
  id_contrato: string;
  cliente: string;
  nit_cliente: string;
  pais: Pais;
  objeto: string;
  valor: number;
  moneda: Moneda;
  fecha_inicio: string;
  fecha_fin: string;
  requiere_poliza: boolean;
  tipo_poliza: string;
  estado_poliza: EstadoPoliza;
  comercial: string;
  ruta_sharepoint: string;
  fecha_registro: string;
  fuente: Fuente;
};

export const MAESTRO_HEADERS: (keyof MaestroRow)[] = [
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
  "estado_poliza",
  "comercial",
  "ruta_sharepoint",
  "fecha_registro",
  "fuente",
];

function escapeCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQuotes = !inQuotes;
    } else if (c === "," && !inQuotes) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function rowToMaestro(row: Record<string, string>): MaestroRow {
  return {
    id_contrato: row.id_contrato,
    cliente: row.cliente,
    nit_cliente: row.nit_cliente,
    pais: row.pais as Pais,
    objeto: row.objeto,
    valor: Number(row.valor),
    moneda: row.moneda as Moneda,
    fecha_inicio: row.fecha_inicio,
    fecha_fin: row.fecha_fin,
    requiere_poliza: row.requiere_poliza === "true",
    tipo_poliza: row.tipo_poliza,
    estado_poliza: row.estado_poliza as EstadoPoliza,
    comercial: row.comercial,
    ruta_sharepoint: row.ruta_sharepoint,
    fecha_registro: row.fecha_registro,
    fuente: row.fuente as Fuente,
  };
}

export function parseCsv(content: string): MaestroRow[] {
  const lines = content.trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = splitCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return rowToMaestro(row);
  });
}

export function maestroToCsv(rows: MaestroRow[]): string {
  const header = MAESTRO_HEADERS.join(",");
  const body = rows
    .map((r) =>
      MAESTRO_HEADERS.map((h) => {
        const v = r[h];
        if (typeof v === "boolean") return v ? "true" : "false";
        return escapeCell(String(v));
      }).join(","),
    )
    .join("\n");
  return `${header}\n${body}\n`;
}
