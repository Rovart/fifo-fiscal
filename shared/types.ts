export type Broker = 'degiro' | 'trade_republic' | 'kraken' | 'revolut' | 'coinbase' | 'cointracking' | 'manual';
export interface Profile { id: string; name: string }
export type AssetClass = 'stock' | 'etf' | 'fund' | 'crypto' | 'bond' | 'other';
export type Market = 'eu' | 'us' | 'other';

export type OpKind =
  | 'buy' | 'sell'
  | 'swap'            // permuta entre criptomonedas (art. 37.1.h LIRPF)
  | 'fx'              // cambio de divisa
  | 'dividend' | 'interest'
  | 'staking'         // RCM, crea lote a valor de mercado
  | 'reward'          // airdrop u otra recompensa: GPP sin transmisión (base general)
  | 'return_capital'  // prima de emisión / reducción de capital: minora coste
  | 'fee'             // comisión suelta
  | 'deposit' | 'withdrawal'
  | 'transfer_in' | 'transfer_out'
  | 'split'           // split, contrasplit o acciones liberadas: varía títulos sin variar coste
  | 'isin_change';    // canje neutro: los lotes pasan al nuevo activo

/** Todos los importes son cadenas decimales para no perder precisión. */
export interface Operation {
  id: string;
  broker: Broker;
  kind: OpKind;
  /** Hora local de España: AAAA-MM-DDTHH:mm:ss */
  datetime: string;
  assetId: string;
  assetName: string;
  assetClass: AssetClass;

  quantity: string | null;
  /** Precio por unidad en `currency`. */
  unitPrice: string | null;
  /** Divisa del precio o del importe. */
  currency: string;
  /** Unidades de `currency` por 1 EUR (convenio BCE). 1 si es EUR. */
  fxRate: string | null;
  fxSource?: 'broker' | 'ecb' | 'manual';
  grossLocal: string | null;
  grossEur: string | null;
  feeEur: string;
  /** Tributos y otros gastos inherentes (ITF, TTF, stamp duty...). */
  otherCostsEur: string;
  withholdingEur: string;
  /** Parte de la retención practicada en España (casilla 0597). El resto es impuesto extranjero. */
  spanishTaxEur?: string | null;
  /** Con signo natural positivo. Compra: lo pagado. Venta o renta: lo cobrado neto. */
  totalEur: string | null;
  /** Divisa en la que se movió el dinero. EUR cuando el bróker convierte al instante (AutoFX). */
  settleCurrency: string;

  /** Las comisiones se pagaron en euros, no en `settleCurrency`: la divisa solo mueve el importe. */
  feesInEur?: boolean;

  /** Permuta, cambio de divisa o canje: lo recibido. */
  counterAsset?: string | null;
  counterName?: string | null;
  counterQuantity?: string | null;

  /** Comisión separada en custodia deducible o no (art. 26 LIRPF). */
  feeClass?: 'custody' | 'non_deductible';
  /** Tributos sumados desde el estado de cuenta, para no repetirlos y poder deshacerlos. */
  appliedCosts?: { key: string; amountEur: string; importId: string }[];
  /** Identifica fills de la misma orden. */
  orderRef?: string | null;
  note?: string;
  reviewReasons?: string[];

  sourceKey?: string | null;
  importId?: string | null;
  original?: Partial<Operation> | null;
  edited?: boolean;
  deleted?: boolean;
  simulated?: boolean;
  /** Solo durante el cálculo de una permuta parcialmente recortada. Nunca se guarda. */
  fifoLeg?: 'swap_in' | 'swap_out' | 'cash_only' | 'inventory_reset';
  /** Exchange de origen cuando el extracto agrega varios, como CoinTracking. */
  sourceExchange?: string;
  /** Evidencia utilizada para completar datos automáticamente, sin marcar una edición manual. */
  resolutions?: { code: 'isin' | 'dividend' | 'corporate_action' | 'fee'; at: string; source: string; detail: string }[];
}

export interface Asset {
  id: string;
  name: string;
  class: AssetClass;
  market: Market;
  /** Símbolo con el que lo identifica un bróker que no da ISIN, como Revolut. */
  ticker?: string;
  /** Mercado elegido a mano: una importación no lo cambia. */
  marketByUser?: boolean;
  /** Fuerza el plazo de recompra en meses (2 o 12). */
  washMonthsOverride?: number | null;
}

export interface Settings {
  /** Detecta el inicio del FIFO actual conservando todos los resultados anteriores. */
  fifoAutoStart?: boolean;
  /** Saldo total cero confirmado por el titular al cierre de un mes ya presentado.
   * Aporta el dato que un extracto de exchange no prueba sobre carteras externas.
   * La clave «CRYPTO:*» lo aplica a todas las criptomonedas. */
  fifoConfirmedClosures?: Record<string, { month: string; note: string }>;
  /** Ventas de cripto sin compra previa entre estas fechas: toman el coste de las compras siguientes,
   * como el informe de CoinTracking con el que se declaró ese periodo. */
  shortfallCover?: { from: string; to: string } | null;
  /** Inicio inclusivo por activo; * es general y CRYPTO:* reinicia todo el historial cripto. */
  fifoStartDates?: Record<string, string>;
  toleranceEur: string;
  /** broker = tipo real de la operación; ecb = todas las conversiones al tipo oficial del BCE. */
  fxSource: 'broker' | 'ecb';
  /** eur = euros a cada fecha. split = separa efecto divisa (V0282-22, V0152-26). */
  fxMethod: 'eur' | 'split';
  fxTracking: boolean;
  washMonths: { eu: number; us: number; other: number };
  treatyDefault: string;
  treatyRates: Record<string, string>;
  /** Pérdidas de ejercicios anteriores a los datos cargados. */
  openingLosses: { year: number; bucket: 'gpp' | 'rcm'; amount: string }[];
  /** Última Renta presentada: hasta ahí, lo pendiente es lo que dice esa Renta y no se recalcula. */
  lastFiledYear?: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  toleranceEur: '0.02',
  fxSource: 'broker',
  fxMethod: 'eur',
  fxTracking: true,
  washMonths: { eu: 2, us: 2, other: 12 },
  treatyDefault: '15',
  treatyRates: {},
  openingLosses: [],
  lastFiledYear: null,
};

export interface ReconcileCheck {
  label: string;
  expected: string;
  actual: string;
  diff: string;
  ok: boolean;
  /** Campo que refleja esta línea en el editor. */
  field?: EditableField;
  /** Campos que pueden ajustarse para que esta línea cuadre. */
  fix?: { field: EditableField; value: string; label: string }[];
}
export interface ReconcileResult {
  ok: boolean;
  checks: ReconcileCheck[];
  missing: string[];
  missingFields: string[];
}

export type EditableField =
  | 'quantity' | 'unitPrice' | 'fxRate' | 'grossLocal' | 'grossEur'
  | 'feeEur' | 'otherCostsEur' | 'withholdingEur' | 'totalEur' | 'counterQuantity';

export type DisposalClass = 'stock' | 'etf' | 'fund' | 'crypto' | 'bond' | 'other' | 'fx';

export interface Match {
  lotId: string;
  acqOpId: string | null;
  acqDate: string;
  quantity: string;
  costEur: string;
  proceedsEur: string;
  gainEur: string;
  /** Sin lote de compra que lo respalde. */
  missing?: boolean;
  /** Bróker donde se hizo la compra. */
  broker?: Broker;
}

export interface Disposal {
  id: string;
  opId: string;
  date: string;
  year: number;
  assetId: string;
  assetName: string;
  class: DisposalClass;
  broker: Broker;
  quantity: string;
  proceedsEur: string;
  costEur: string;
  gainEur: string;
  /** F moneda de curso legal, N otra moneda virtual (casilla 1803). */
  clave?: 'F' | 'N';
  matches: Match[];
  shortfall: string;
  incomplete?: boolean;
  /** Efecto divisa separado de una venta. */
  derived?: boolean;
  simulated?: boolean;
}

export interface LossTranche {
  id: string;
  assetId: string;
  assetName: string;
  class: DisposalClass;
  originDisposalId: string;
  originDate: string;
  quantity: string;
  amountEur: string;
  status: 'integrated' | 'blocked' | 'pending_window';
  /** Fecha cuya transmisión permite integrarla. */
  date: string;
  year: number;
  windowEnd: string;
  blockerLotId?: string;
  blockerDate?: string;
  /** Títulos que se venderán antes de llegar a los que liberan esta pérdida. */
  aheadQty?: string;
}

export interface Income {
  opId: string;
  date: string;
  year: number;
  type: 'dividend' | 'interest' | 'staking' | 'reward' | 'capital_excess' | 'bond';
  assetId: string;
  assetName: string;
  broker: Broker;
  country: string;
  grossEur: string;
  foreignTaxEur: string;
  spanishTaxEur: string;
  feeEur: string;
  netEur: string;
}

export interface FeeEntry {
  opId: string;
  date: string;
  year: number;
  broker: Broker;
  label: string;
  amountEur: string;
  feeClass: 'custody' | 'non_deductible';
}

export interface OpenLot {
  lotId: string;
  assetId: string;
  assetName: string;
  class: DisposalClass;
  acqDate: string;
  quantity: string;
  costEur: string;
  unitCostEur: string;
  blockedQuantity: string;
  acqOpId: string | null;
}

export interface Position {
  assetId: string;
  assetName: string;
  class: DisposalClass;
  quantity: string;
  costEur: string;
  byBroker: Record<string, string>;
}

export interface Issue {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  opId?: string;
  assetId?: string;
  assetName?: string;
  date?: string;
  quantity?: string;
  /** Motivo de revisión, para agrupar y confirmar en bloque. */
  reason?: string;
  /** Si es falso, el aviso no cambia el FIFO de ejercicios posteriores. */
  affectsFuture?: boolean;
  year?: number;
  /** Faltan compras de algo que llegó de fuera y ya se vendió entero: los años siguientes no dependen de ello. */
  settled?: boolean;
}

export interface SaleSimulation {
  assetId: string;
  quantity: string;
  proceedsEur: string;
  costEur: string;
  gainEur: string;
  /** Parte de la pérdida que no contaría todavía. */
  deferredEur: string;
  /** Pérdidas aplazadas antes que esta venta haría contar. */
  releasedEur: string;
  /** Fecha desde la que recomprar no aplaza la pérdida. Sin plazo en cripto. */
  safeRebuyFrom: string | null;
  matches: Match[];
}

/** Varias ventas calculadas juntas: el impuesto de la suma no es la suma de los impuestos. */
export interface SalesSimulation {
  sales: SaleSimulation[];
  proceedsEur: string;
  gainEur: string;
  deferredEur: string;
  releasedEur: string;
  /** A pagar con lo vendido hasta hoy y con estas ventas, tras retenciones y deducciones. */
  payBefore: string;
  payAfter: string;
  year: number;
  /** Hasta esta pérdida se reduce lo que se paga este año. */
  usefulLossEur: string;
  usedLossEur: string;
  /** Pérdida que excede de lo anterior y queda para los 4 años siguientes. */
  extraLossEur: string;
}

export type IncomeGroup = 'dividends' | 'interest' | 'staking' | 'rewards' | 'other';
export const INCOME_GROUP: Record<Income['type'], IncomeGroup> = {
  dividend: 'dividends', interest: 'interest', staking: 'staking', reward: 'rewards', capital_excess: 'other', bond: 'other',
};

export interface PerformanceYear {
  year: number;
  /** Ganancias y pérdidas de lo vendido, también las aplazadas: es lo que pasó, no lo que tributa. */
  realizedEur: string;
  /** Dividendos, intereses, staking y recompensas, brutos. */
  incomeEur: string;
  /** El mismo importe por tipo de ingreso. */
  incomeByType: Record<IncomeGroup, string>;
  feesEur: string;
  /** Lo que se ganaría o perdería vendiendo al final del año. */
  unrealizedEndEur: string;
  unrealizedChangeEur: string;
  resultEur: string;
  /** Rentabilidad de Dietz modificada: el resultado sobre el dinero que estuvo invertido, según cuánto tiempo lo estuvo. */
  returnPct: string | null;
  valueEndEur: string;
  costEndEur: string;
  /** Vendido sin coste conocido: no cuenta como ganancia. */
  unknownCostProceedsEur: string;
  /** IRPF estimado de los años sin presentar. */
  taxEur: string | null;
}

export interface PerformanceAssetYear {
  realizedEur: string;
  incomeEur: string;
  unrealizedChangeEur: string;
  unrealizedEndEur: string;
  valueEndEur: string;
  resultEur: string;
}

export interface PerformanceAsset {
  assetId: string;
  assetName: string;
  class: DisposalClass;
  years: Record<number, PerformanceAssetYear>;
}

export interface PerformanceData {
  years: PerformanceYear[];
  assets: PerformanceAsset[];
  months: { month: string; valueEur: string; costEur: string }[];
  /** Valor actual por sitio donde está guardado. */
  places: { broker: string; valueEur: string }[];
  totalResultEur: string;
  /** Rentabilidades de cada año encadenadas. */
  totalReturnPct: string | null;
  /** Activos sin precio: cuentan a su coste, sin ganancia ni pérdida. */
  missingPrices: string[];
  hasHistory: boolean;
  fetchedAt: string | null;
}

export interface EngineResult {
  /** Ajustes de inventario confirmados; no son ventas ni alteran el resultado anterior. */
  inventoryResets?: { assetId: string; date: string; quantityBefore: string; costEurBefore: string; note: string }[];
  /** Consumos de lotes sin transmisión fiscal, como comisiones pagadas en cripto. */
  lotUses?: { opId: string; assetId: string; date: string; acqDates: string[] }[];
  disposals: Disposal[];
  tranches: LossTranche[];
  incomes: Income[];
  fees: FeeEntry[];
  openLots: OpenLot[];
  positions: Position[];
  snapshots: Record<number, Position[]>;
  /** Posiciones a cierre de cada mes, si se piden. */
  monthly?: Record<string, Position[]>;
  issues: Issue[];
  years: number[];
  /** Gastos en divisa todavía pendientes de un ingreso que los cubra. */
  fxShorts?: { currency: string; date: string; quantity: string; eur: string }[];
  unmatchedTransfers?: { assetId: string; quantity: string }[];
  fifoAuto?: { verified: boolean; starts: Record<string, string>; previousOperations: number; externalAssets: string[] };
}

export interface FifoHistory {
  /** Datos necesarios para continuar desde las posiciones y pérdidas actuales. No sustituye una Renta anterior. */
  from: string | null;
  cryptoFrom?: string | null;
  complete: boolean;
  assets: { assetId: string; assetName: string; from: string; deferred: boolean }[];
  closedAssets: number;
  auto?: EngineResult['fifoAuto'];
}

export const CLASS_LABEL: Record<DisposalClass, string> = {
  stock: 'Acción', etf: 'ETF', fund: 'Fondo', crypto: 'Cripto', bond: 'Renta fija / ETC', other: 'Otro', fx: 'Divisa',
};
export const KIND_LABEL: Record<OpKind, string> = {
  buy: 'Compra', sell: 'Venta', swap: 'Cambio de cripto', fx: 'Cambio de moneda', dividend: 'Dividendo',
  interest: 'Interés', staking: 'Staking', reward: 'Regalo o airdrop', return_capital: 'Devolución de capital',
  fee: 'Comisión', deposit: 'Ingreso', withdrawal: 'Retirada', transfer_in: 'Entrada desde otra cuenta',
  transfer_out: 'Salida a otra cuenta', split: 'Split o acciones gratis', isin_change: 'Canje de acciones',
};
export const BROKER_LABEL: Record<Broker, string> = {
  degiro: 'DEGIRO', trade_republic: 'Trade Republic', kraken: 'Kraken', revolut: 'Revolut', coinbase: 'Coinbase', cointracking: 'CoinTracking', manual: 'Manual',
};
