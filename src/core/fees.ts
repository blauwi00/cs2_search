// Реестр комиссий. Все суммы — целые минимальные единицы.

export interface SteamFeeParams {
  walletFeePercentBp: number;   // 500 = 5% (Steam)
  publisherFeePercentBp: number; // 1000 = 10% (CS2)
  walletFeeMinimum: number;     // минимальная комиссия Steam в мин. единицах
  publisherFeeMinimum: number;  // минимальная комиссия CS2
  walletFeeBase: number;
}

/**
 * Параметры для CS2. Проценты 5% + 10% — публичная информация Steam.
 * Минимум 1 мин. единица — подтверждён для USD (0,01 $). Для UAH отдельной документации не найдено:
 * используется 1 копейка, это ДОПУЩЕНИЕ (влияет только на очень дешёвые предметы).
 */
export const STEAM_CS2_FEES: SteamFeeParams = {
  walletFeePercentBp: 500,
  publisherFeePercentBp: 1000,
  walletFeeMinimum: 1,
  publisherFeeMinimum: 1,
  walletFeeBase: 0,
};

export interface SteamFeeBreakdown {
  buyerPays: number;
  sellerReceives: number;
  steamFee: number;
  publisherFee: number;
}

/** Сколько заплатит покупатель, если продавец хочет получить received (логика как в клиентском JS Steam). */
export function steamBuyerPriceForReceived(received: number, p: SteamFeeParams = STEAM_CS2_FEES): SteamFeeBreakdown {
  const steamFee = Math.floor(Math.max((received * p.walletFeePercentBp) / 10000, p.walletFeeMinimum) + p.walletFeeBase);
  const publisherFee = p.publisherFeePercentBp > 0
    ? Math.floor(Math.max((received * p.publisherFeePercentBp) / 10000, p.publisherFeeMinimum))
    : 0;
  return { buyerPays: received + steamFee + publisherFee, sellerReceives: received, steamFee, publisherFee };
}

/**
 * Сколько получит продавец, если покупатель платит buyerPays.
 * Повторяет итеративный алгоритм Steam: подбирает максимальный received, при котором цена покупателя ≤ buyerPays;
 * если точного совпадения нет, недостающая копейка уходит в комиссию Steam.
 */
export function steamSellerProceeds(buyerPays: number, p: SteamFeeParams = STEAM_CS2_FEES): SteamFeeBreakdown | null {
  if (!Number.isSafeInteger(buyerPays) || buyerPays <= 0) return null;
  const minBuyer = steamBuyerPriceForReceived(1, p).buyerPays;
  if (buyerPays < minBuyer) return null; // ниже минимальной цены выставления
  const totalBp = 10000 + p.walletFeePercentBp + p.publisherFeePercentBp;
  let est = Math.floor(((buyerPays - p.walletFeeBase) * 10000) / totalBp);
  if (est < 1) est = 1;
  // Сдвигаем оценку, пока не найдём максимальный received с buyerPays(received) <= buyerPays.
  for (let i = 0; i < 20 && est > 1 && steamBuyerPriceForReceived(est, p).buyerPays > buyerPays; i++) est--;
  for (let i = 0; i < 20 && steamBuyerPriceForReceived(est + 1, p).buyerPays <= buyerPays; i++) est++;
  const b = steamBuyerPriceForReceived(est, p);
  const diff = buyerPays - b.buyerPays;
  return { buyerPays, sellerReceives: est, steamFee: b.steamFee + diff, publisherFee: b.publisherFee };
}

export interface MarketFeeInfo {
  source: string;
  buyerFeeBp: number | null;      // null = неизвестно
  sellerFeeBp: number | null;
  withdrawFeeKnown: boolean;
  note: string;
  verifiedAt: string;
  docUrl: string | null;
}

/**
 * Комиссии площадок. Значения, которые не подтверждены официальной документацией, оставлены null:
 * бот не подставляет выдуманные цифры и показывает предупреждение.
 */
export const FEE_REGISTRY: Record<string, MarketFeeInfo> = {
  steam: {
    source: 'steam', buyerFeeBp: 0, sellerFeeBp: 1500, withdrawFeeKnown: true,
    note: '5% Steam + 10% CS2, удерживаются из цены покупателя; вывод денег из кошелька невозможен.',
    verifiedAt: '2026-11-04', docUrl: 'https://help.steampowered.com/',
  },
  skinport: {
    source: 'skinport', buyerFeeBp: null, sellerFeeBp: null, withdrawFeeKnown: false,
    note: 'Цена объявления = цена покупки; комиссия платёжного метода и комиссия продавца в API не указаны — не учитываются.',
    verifiedAt: '2026-11-04', docUrl: 'https://docs.skinport.com/',
  },
  csfloat: {
    source: 'csfloat', buyerFeeBp: null, sellerFeeBp: null, withdrawFeeKnown: false,
    note: 'Комиссии в публичной документации API не указаны — не учитываются.',
    verifiedAt: '2026-11-04', docUrl: 'https://docs.csfloat.com/',
  },
};

/**
 * Выплата Steam в валюте кошелька (аудит, приоритет 2): минимальные комиссии — по 1 минимальной единице ИМЕННО этой валюты
 * (0,01 $ для USD, 1 коп. для UAH), округление — как в Steam. Суммы на входе/выходе — в копейках гривны (внутренняя единица бота);
 * per — сколько гривен стоит 1 единица валюты кошелька. Для UAH пересчёта нет.
 * Ниже минимальной цены выставления (3 мин. единицы) — null.
 */
export function steamNetKop(buyerKop: number, wallet: { per: number } = { per: 1 }): number | null {
  if (!(buyerKop > 0)) return null;
  if (wallet.per === 1) return steamSellerProceeds(Math.round(buyerKop))?.sellerReceives ?? null;
  const units = Math.round(buyerKop / wallet.per);            // в сотых долях валюты кошелька
  const p = steamSellerProceeds(units);
  return p ? Math.floor(p.sellerReceives * wallet.per) : null;
}

/** Сколько должен заплатить покупатель, чтобы на баланс пришло netKop (та же валюта кошелька). */
export function steamListForNetKop(netKop: number, wallet: { per: number } = { per: 1 }): number {
  if (wallet.per === 1) return steamBuyerPriceForReceived(Math.max(1, Math.round(netKop))).buyerPays;
  const units = Math.max(1, Math.ceil(netKop / wallet.per));
  return Math.ceil(steamBuyerPriceForReceived(units).buyerPays * wallet.per);
}
