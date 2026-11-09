// #14: калькулятор «сколько придёт после комиссий» для любой цены и площадки (и обратный: за сколько выставить).
// Комиссии продавца — по сводке CSDB (csdb.gg, июль 2026) и правилам Steam; меняются — сверять раз в несколько месяцев.
import { steamSellerProceeds, steamBuyerPriceForReceived } from './fees.ts';
import { siteIcon, SITES } from './sites.ts';

export const CALC_SITES: { key: string; name: string; feeBp: number; note?: string }[] = [
  { key: 'skinport', name: 'Skinport', feeBp: 800, note: 'не меньше 1 евроцента; 6% для продаж дороже 1000 €' },
  { key: 'csfloat', name: 'CSFloat', feeBp: 200 },
  { key: 'csdeals', name: 'CS.Deals', feeBp: 200, note: 'деньги приходят через 7 дней' },
  { key: 'dmarket', name: 'DMarket', feeBp: 200, note: 'у редко продаваемых предметов до 10%' },
  { key: 'buffmarket', name: 'BUFF Market', feeBp: 250 },
  { key: 'csgomarket', name: 'Market.CSGO', feeBp: 500, note: 'плюс комиссия при выводе' },
  { key: 'lisskins', name: 'LIS-SKINS', feeBp: 500, note: '5–6%' },
  { key: 'csmoney', name: 'CS.MONEY', feeBp: 500, note: '3% для продаж дороже 1000 $' },
  { key: 'waxpeer', name: 'Waxpeer', feeBp: 600 },
  { key: 'skinbaron', name: 'SkinBaron', feeBp: 1500, note: '7,5% для приватных предложений' },
];

export interface CalcRow { key: string; name: string; icon: string; feeText: string; note: string | null; wallet: 'steam' | 'cash'; listKop: number; getKop: number }

const iconOf = (key: string, fallback: string) => siteIcon(SITES.find((s) => s.key === key)?.url ?? fallback);

/** mode 'sell': выставляю за kop — сколько получу; mode 'get': хочу получить kop — за сколько выставить. withdrawBp — комиссия вывода с сайтов. */
/** minFeeKop — минимальная комиссия площадки в копейках (Skinport: 1 евроцент по курсу). */
export function calcFees(kop: number, mode: 'sell' | 'get', withdrawBp: number, minFeeKop: Record<string, number> = {}): CalcRow[] {
  const rows: CalcRow[] = [];
  const w = Math.max(0, Math.min(3000, withdrawBp));
  // Steam: точная формула (5% Steam + 10% CS2, минимум по 1 коп.), деньги остаются на балансе Steam.
  if (mode === 'sell') {
    const p = steamSellerProceeds(kop);
    if (p) rows.push({ key: 'steam', name: 'Steam Market', icon: iconOf('steam', 'https://steamcommunity.com/'), feeText: '15%', note: 'на баланс Steam — вывести нельзя', wallet: 'steam', listKop: kop, getKop: p.sellerReceives });
  } else {
    const b = steamBuyerPriceForReceived(kop);
    rows.push({ key: 'steam', name: 'Steam Market', icon: iconOf('steam', 'https://steamcommunity.com/'), feeText: '15%', note: 'на баланс Steam — вывести нельзя', wallet: 'steam', listKop: b.buyerPays, getKop: kop });
  }
  for (const s of CALC_SITES) {
    const keep = (10000 - s.feeBp) * (10000 - w) / 1e8;
    const min = minFeeKop[s.key] ?? 0;
    const fee = (list: number) => Math.max((list * s.feeBp) / 10000, min);
    let listKop = mode === 'sell' ? kop : Math.ceil(kop / keep);
    // Процент меньше минимальной комиссии — считаем от минимума.
    if (mode === 'get' && fee(listKop) > (listKop * s.feeBp) / 10000) listKop = Math.ceil(kop / ((10000 - w) / 10000) + min);
    const getKop = mode === 'sell' ? Math.max(0, Math.floor((kop - fee(kop)) * (10000 - w) / 10000)) : kop;
    rows.push({ key: s.key, name: s.name, icon: iconOf(s.key, `https://${s.key}.com/`), feeText: `${(s.feeBp / 100).toString().replace('.', ',')}%${w ? ` + вывод ${(w / 100).toString().replace('.', ',')}%` : ''}`,
      note: s.note ?? null, wallet: 'cash', listKop, getKop });
  }
  return mode === 'sell' ? rows.sort((a, b) => b.getKop - a.getKop) : rows.sort((a, b) => a.listKop - b.listKop);
}
