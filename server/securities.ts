/** Correspondencias de clase y bolsa contrastadas con el emisor o la bolsa. */
export const SECURITIES = [
  { ticker: '6AQQ', isin: 'LU1681038243', name: 'Amundi Nasdaq-100 Swap UCITS ETF EUR Acc', symbols: ['6AQQ.DE', 'ANX.PA', 'ANX.MI'], source: 'https://www.amundietf.com/pdfDocuments/monthly-factsheet/LU1681038243/ENG/GBR/INSTITUTIONNEL/ETF/20260430' },
  { ticker: 'IS04', isin: 'IE00BSKRJZ44', name: 'iShares $ Treasury Bond 20+yr UCITS ETF USD (Dist)', symbols: ['IS04.DE'], source: 'https://www.ishares.com/de/professionelle-anleger/de/produkte/272124/ishares-usd-treasury-bond-20-yr-ucits-etf' },
  { ticker: 'VUAA', isin: 'IE00BFMXXD54', name: 'Vanguard S&P 500 UCITS ETF USD Accumulating', symbols: ['VUAA.DE', 'VUAA.MI', 'VUAA.L'], source: 'https://global.vanguard.com/de-de/investment-products/etf/equities/9694/s-p-500-ucits-etf' },
  { ticker: 'X9I1', isin: 'LU1681045453', name: 'Amundi MSCI Emerging Markets Swap UCITS ETF USD Acc', symbols: ['X9I1.DU', 'X9I1.HA', 'AUEM.L'], source: 'https://www.boerse-stuttgart.de/en/products/etps/etfs/stuttgart/a2h58k-amundi-index-solutions-amundi-msci-emerging-markets---ucits-etf---usd' },
];
export const securityFor = (id: string) => SECURITIES.find((s) => s.ticker === id.toUpperCase() || s.isin === id.toUpperCase());
