import { normalizeText } from "./similarity";

const UNIDADES: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
  diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiun: 21, veintiuno: 21, veintidos: 22, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, doscientas: 200, trescientos: 300, trescientas: 300,
  cuatrocientos: 400, cuatrocientas: 400, quinientos: 500, quinientas: 500, seiscientos: 600,
  seiscientas: 600, setecientos: 700, setecientas: 700, ochocientos: 800, ochocientas: 800,
  novecientos: 900, novecientas: 900, primero: 1,
};

/**
 * Convierte el número escrito en letras al inicio de un texto a entero:
 * "DOSCIENTOS SESENTA Y CINCO MILLONES DE PESOS" → 265000000.
 * Se detiene en la primera palabra no numérica ("de pesos", "dólares").
 * Devuelve null si el texto no empieza con un número en letras.
 * Sirve para verificar el valor en cifras contra el valor en letras.
 */
export function letrasANumero(texto: string): number | null {
  const palabras = normalizeText(texto).split(" ").filter((w) => w && w !== "y");
  if (palabras.length === 0) return null;
  let total = 0;
  let grupo = 0;
  let leidas = 0;
  for (const p of palabras) {
    if (p in UNIDADES) grupo += UNIDADES[p];
    else if (p === "mil") {
      grupo = (grupo || 1) * 1000;
      total += grupo;
      grupo = 0;
    } else if (p === "millon" || p === "millones") {
      total = (total + (grupo || 1)) * 1_000_000;
      grupo = 0;
    } else break;
    leidas++;
  }
  return leidas === 0 ? null : total + grupo;
}

/** Interpreta una cifra según la convención de la moneda: COP usa punto de miles; USD/PEN usan coma. */
export function parseCifra(raw: string, moneda: string): number | null {
  const limpio = raw.trim().replace(/\s/g, "");
  let normal: string;
  if (moneda === "COP") {
    normal = limpio.replace(/\./g, "").replace(/,(\d{1,2})$/, ".$1");
  } else {
    normal = limpio.replace(/,/g, "");
  }
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}
