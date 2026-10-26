/**
 * Money handling.
 *
 * PRD §9: "Monetary values use decimal/numeric or integer minor units plus
 * currency; never IEEE binary float for money." Amounts are therefore integer
 * minor units end to end — API, database, policy evaluation, connector.
 */

/** ISO-4217 minor-unit exponents for the currencies the demo corpus uses. */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  CAD: 2,
  AUD: 2,
  SGD: 2,
  JPY: 0,
  KRW: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
};

export const SUPPORTED_CURRENCIES = Object.freeze(Object.keys(CURRENCY_EXPONENTS).sort());

export class MoneyError extends Error {
  readonly code = 'INVALID_MONEY';
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

export interface Money {
  /** Integer minor units (cents for a 2-exponent currency). */
  amountMinor: number;
  currency: string;
}

export function isSupportedCurrency(currency: string): boolean {
  return Object.hasOwn(CURRENCY_EXPONENTS, currency);
}

export function currencyExponent(currency: string): number {
  const exp = CURRENCY_EXPONENTS[currency];
  if (exp === undefined) {
    throw new MoneyError(`unsupported currency: ${currency}`);
  }
  return exp;
}

/** Validate an amount/currency pair, rejecting floats and unsafe integers. */
export function assertValidAmountMinor(amountMinor: unknown, currency: string): void {
  if (typeof currency !== 'string' || !isSupportedCurrency(currency)) {
    throw new MoneyError(`unsupported or malformed currency: ${String(currency)}`);
  }
  if (typeof amountMinor !== 'number') {
    throw new MoneyError('amount_minor must be a number in minor units');
  }
  if (!Number.isInteger(amountMinor)) {
    // A fractional "minor unit" means the caller sent a major-unit float.
    throw new MoneyError(
      'amount_minor must be an integer; send minor units, not a decimal major amount',
    );
  }
  if (!Number.isSafeInteger(amountMinor)) {
    throw new MoneyError('amount_minor exceeds safe integer range');
  }
}

export function money(amountMinor: number, currency: string): Money {
  assertValidAmountMinor(amountMinor, currency);
  return { amountMinor, currency: currency.toUpperCase() };
}

/** Convert a major-unit decimal *string* to minor units without float error. */
export function parseMajorToMinor(major: string, currency: string): number {
  const exp = currencyExponent(currency);
  const trimmed = major.trim();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new MoneyError(`cannot parse amount: ${major}`);
  }
  const [, sign, intPart, fracPartRaw] = match;
  const fracPart = fracPartRaw ?? '';
  if (fracPart.length > exp) {
    throw new MoneyError(
      `amount ${major} has more than ${exp} decimal places for ${currency}`,
    );
  }
  const padded = fracPart.padEnd(exp, '0');
  const minor = BigInt(`${intPart}${padded}`);
  const value = sign === '-' ? -minor : minor;
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new MoneyError(`amount ${major} ${currency} exceeds safe integer range`);
  }
  return Number(value);
}

/** Format minor units for display with tabular-friendly fixed decimals. */
export function formatMoney(m: Money): string {
  const exp = currencyExponent(m.currency);
  const divisor = 10n ** BigInt(exp);
  const sign = m.amountMinor < 0 ? '-' : '';
  const abs = BigInt(Math.abs(m.amountMinor));
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(exp, '0');
  return exp === 0 ? `${sign}${whole} ${m.currency}` : `${sign}${whole}.${frac} ${m.currency}`;
}

export function compareMoney(a: Money, b: Money): number {
  if (a.currency !== b.currency) {
    throw new MoneyError(`cannot compare ${a.currency} with ${b.currency}`);
  }
  return a.amountMinor === b.amountMinor ? 0 : a.amountMinor < b.amountMinor ? -1 : 1;
}
