const MESES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

export const MES_RE = "(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)";

export function mesANumero(nombre: string): number | null {
  return MESES[nombre.toLowerCase()] ?? null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Construye una fecha ISO y la rechaza si no existe en el calendario (p. ej. 31 de febrero). */
export function isoValida(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export function esIso(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return Boolean(m && isoValida(Number(m[1]), Number(m[2]), Number(m[3])));
}

export function sumarMeses(iso: string, meses: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + meses, d));
  return dt.toISOString().slice(0, 10);
}

export function sumarDias(iso: string, dias: number): string {
  const dt = new Date(`${iso}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + dias);
  return dt.toISOString().slice(0, 10);
}

export function ultimoDiaDelMes(y: number, m: number): string {
  const dt = new Date(Date.UTC(y, m, 0));
  return dt.toISOString().slice(0, 10);
}

export function diasEntre(desde: string, hasta: string): number {
  const a = new Date(`${desde}T00:00:00Z`).getTime();
  const b = new Date(`${hasta}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * Busca la primera fecha escrita en español dentro de un fragmento:
 * "quince (15) de agosto de 2026", "1 de noviembre de 2027".
 * Devuelve `invalida: true` si la fecha está escrita pero no existe.
 */
export function buscarFecha(fragmento: string): { iso: string | null; invalida: boolean } {
  const re = new RegExp(`(?:\\((\\d{1,2})\\)|\\b(\\d{1,2}))\\s+de\\s+${MES_RE}\\s+de\\s+(\\d{4})`, "i");
  const m = re.exec(fragmento);
  if (!m) return { iso: null, invalida: false };
  const dia = Number(m[1] ?? m[2]);
  const mes = mesANumero(m[3]) ?? 0;
  const iso = isoValida(Number(m[4]), mes, dia);
  return { iso, invalida: iso === null };
}
