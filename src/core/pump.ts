// Детектор вбросов и разгонов цены (pump & dump).
// Признаки из гайдов по трейдингу скинов (csmarketcap, skinbase, pirateswap, white.market):
// цену поднимают на тонком рынке — мало продаж и продавцов, — подогревают «новостями», продают на пике.
// Настоящий рост обычно идёт при большом числе продаж, с ордерами покупателей и сразу на всех площадках.
// Поэтому «разгон» — это заметный рост цены за месяц плюс хотя бы один признак искусственности.
// Все цены во входе — в одной единице (центы USD или копейки), важны только отношения.

export interface PumpInput {
  d1?: number | null; d30?: number | null;        // средние продаж Steam за сутки и за месяц
  s7?: number | null; s30?: number | null;        // медиана продаж Skinport за неделю и за месяц
  vol24?: number | null;                          // продаж в Steam за сутки
  sales7?: number | null;                         // продаж на Skinport за неделю
  listings?: number | null;                       // объявлений на площадках всего
  listing?: number | null; buyOrder?: number | null; // самое дешёвое объявление Steam и лучший ордер покупателя
  siteNow?: number | null;                        // типичная цена на других площадках сейчас (в единице d1)
}

export interface Pump { riseBp: number; reasons: string[] }

export const PUMP_RISE = 1.3;       // рост на 30%+ за месяц — уже повод присмотреться
const SPIKE_RISE = 2;               // вдвое за месяц без большого числа продаж — почти всегда разгон
const THIN_VOL24 = 15, THIN_SALES7 = 15, FEW_LISTINGS = 10;

export function pumpCheck(i: PumpInput): Pump | null {
  const ratio = (a?: number | null, b?: number | null) => (a && b && a > 0 && b > 0 ? a / b : null);
  const rSteam = ratio(i.d1, i.d30), rSite = ratio(i.s7, i.s30);
  const rise = Math.max(rSteam ?? 0, rSite ?? 0);
  if (rise < PUMP_RISE) return null;
  const why: string[] = [];
  if (i.vol24 != null) { if (i.vol24 < THIN_VOL24) why.push(`мало продаж: ${i.vol24} за сутки в Steam — цену легко сдвинуть`); }
  else if (i.sales7 != null && i.sales7 < THIN_SALES7) why.push(`мало продаж: ${i.sales7} за неделю на Skinport`);
  if (rSteam && rSteam >= PUMP_RISE && rSite != null && rSite < 1.1) why.push('в Steam цена выросла, а на Skinport — нет');
  else if (rSite && rSite >= PUMP_RISE && rSteam != null && rSteam < 1.1) why.push('на Skinport цена выросла, а в Steam — нет');
  if (i.d1 && i.siteNow && i.d1 > i.siteNow * 1.6) why.push('на других площадках предмет намного дешевле — там рост не подтвердился');
  if (i.listings != null && i.listings < FEW_LISTINGS) why.push(`почти нет продавцов (${i.listings} объявлений) — цену держат несколько человек`);
  if (i.listing && i.buyOrder && i.buyOrder < i.listing * 0.6) why.push(`покупатели не готовы платить столько: лучший ордер на ${Math.round((1 - i.buyOrder / i.listing) * 100)}% ниже объявления`);
  if (rise >= SPIKE_RISE && !(i.vol24 != null && i.vol24 >= 200)) why.push(`цена выросла в ${rise.toFixed(1).replace(/\.0$/, '').replace('.', ',')} раза за месяц без большого спроса`);
  return why.length ? { riseBp: Math.round((rise - 1) * 10000), reasons: why } : null;
}
