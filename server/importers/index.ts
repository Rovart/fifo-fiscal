import type { ParsedImport, RateFn } from './common.ts';
import { looksLikeCoinbase, parseCoinbase, skipCoinbasePreamble } from './coinbase.ts';
import { looksLikeCoinTracking, looksLikeCoinTrackingReport, parseCoinTracking, type Coverage } from './cointracking.ts';
import { parseCsv } from './csv.ts';
import { looksLikeDegiroAccount, looksLikeDegiroTransactions, parseDegiroAccount, parseDegiroTransactions } from './degiro.ts';
import { looksLikeKrakenLedger, looksLikeKrakenTrades, parseKrakenLedger } from './kraken.ts';
import { looksLikeRevolutBank, looksLikeRevolutCrypto, looksLikeRevolutStocks, parseRevolutCrypto, parseRevolutStocks } from './revolut.ts';
import { looksLikeTradeRepublic, parseTradeRepublic } from './traderepublic.ts';

export function parseFile(text: string, rate: RateFn, coverage: Coverage = {}): ParsedImport {
  const { headers, rows } = parseCsv(skipCoinbasePreamble(text));
  if (looksLikeCoinTracking(headers)) return parseCoinTracking(headers, rows, rate, coverage);
  if (looksLikeCoinTrackingReport(headers)) {
    throw new Error('Es el informe fiscal de CoinTracking, con ganancias ya calculadas. Exporta la lista de operaciones: Introducir monedas → Exportar → CSV.');
  }
  if (looksLikeTradeRepublic(headers)) return parseTradeRepublic(headers, rows, rate);
  if (looksLikeKrakenLedger(headers)) return parseKrakenLedger(headers, rows, rate);
  if (looksLikeKrakenTrades(headers)) {
    throw new Error('Es el fichero de operaciones de Kraken. Exporta «Ledgers»: incluye depósitos, staking y comisiones.');
  }
  if (looksLikeCoinbase(headers)) return parseCoinbase(headers, rows, rate);
  if (looksLikeRevolutStocks(headers)) return parseRevolutStocks(headers, rows, rate);
  if (looksLikeRevolutCrypto(headers)) return parseRevolutCrypto(headers, rows, rate);
  if (looksLikeRevolutBank(headers)) {
    throw new Error('Es el extracto de tu cuenta de Revolut. Descarga el de Inversiones o el de Cripto.');
  }
  if (looksLikeDegiroAccount(headers)) return parseDegiroAccount(headers, rows, rate);
  if (looksLikeDegiroTransactions(headers)) return parseDegiroTransactions(headers, rows, rate);
  throw new Error(`Formato no reconocido. Cabeceras: ${headers.slice(0, 8).join(', ')}`);
}

export type { ParsedImport, RateFn, PendingCost, DeclaredBalance } from './common.ts';
export type { Coverage } from './cointracking.ts';
