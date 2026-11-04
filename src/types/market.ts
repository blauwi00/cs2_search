export type SourceId = 'steam' | 'skinport' | 'csfloat';
export type Currency = 'UAH' | 'USD' | 'EUR' | 'PLN';

export type PriceType =
  | 'lowest_listing'     // самое дешёвое активное объявление
  | 'median_24h'         // медиана продаж за 24 ч (Steam)
  | 'sale_median_7d'     // медиана продаж за 7 дней (Skinport sales history)
  | 'sale_median_30d'
  | 'listing';           // конкретное объявление (CSFloat)

export type Quality = 'ok' | 'partial' | 'stale';

/** Единый внутренний формат котировки, который возвращают все адаптеры. */
export interface Quote {
  source: SourceId;
  marketHashName: string;
  priceType: PriceType;
  /** Цена в минимальных единицах исходной валюты. null = неизвестно (НЕ ноль). */
  priceMinor: number | null;
  currency: Currency;
  /** Число активных объявлений, если источник сообщает. */
  quantity: number | null;
  /** Число завершённых продаж за volumePeriod, если источник сообщает. */
  volume: number | null;
  volumePeriod: '24h' | '7d' | '30d' | '90d' | null;
  listingId: string | null;
  floatValue: number | null;
  paintSeed: number | null;
  url: string | null;
  fetchedAt: number;
  sourceUpdatedAt: number | null;
  /** Можно ли сразу передать предмет. null = неизвестно. */
  tradable: boolean | null;
  quality: Quality;
}

export type FetchErrorKind =
  | 'timeout' | 'rate_limited' | 'forbidden' | 'server' | 'bad_json' | 'schema' | 'auth' | 'network' | 'not_found';

export class SourceError extends Error {
  readonly kind: FetchErrorKind;
  readonly status: number | null;
  readonly retryAfterSec: number | null;
  constructor(kind: FetchErrorKind, message: string, status: number | null = null, retryAfterSec: number | null = null) {
    super(message);
    this.kind = kind;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}
