import { z } from 'zod';

// FHS-613: one place that turns an amount into money the family can read.
//
// Before this, every screen glued the currency code onto a number by hand
// ("AED 7.50"). That only ever looks right for codes that sit in front with a
// space: it produces "USD 7.50" instead of "$7.50", "GBP 7.50" instead of
// "£7.50", and "EUR 7.50" instead of "7,50 €". It also ignores the viewer's
// decimal separator and digit grouping.
//
// Intl.NumberFormat knows all of that. The family picks the currency during
// onboarding (tenants.currency); the placement, separators and grouping come
// from the viewer's own locale.

/**
 * The viewer's locale. There is no locale column: the family chooses a
 * currency, not a language, so the formatting conventions come from the device
 * (the same source `CurrencyPicker` already uses to guess a currency). Outside
 * a browser this returns undefined, which lets Intl use the runtime default.
 */
export function viewerLocale(): string | undefined {
  // Read off globalThis rather than the DOM global: this package is compiled
  // for the api too, where `navigator` does not exist as a type.
  const nav = (globalThis as { navigator?: { language?: string } }).navigator;
  return nav?.language || undefined;
}

/**
 * Format a major-unit amount as the family's currency, e.g.
 * `formatMoney(7.5, 'AED')` → "AED 7.50", `formatMoney(7.5, 'USD')` → "$7.50".
 *
 * Falls back to "<CODE> <amount>" when the code is not one Intl recognises, so
 * a bad value in the database can never blank out a figure on screen.
 */
export function formatMoney(amount: number, currency: string, locale?: string): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  try {
    return new Intl.NumberFormat(locale ?? viewerLocale(), {
      style: 'currency',
      currency,
    }).format(safe);
  } catch {
    return `${currency} ${safe.toFixed(2)}`;
  }
}

/**
 * Same, for an amount already in minor units (150 + "AED" → "AED 1.50"). The
 * sticker rate and every stored price are held in minor units to keep the
 * money maths in integers.
 */
export function formatMoneyMinor(amountMinor: number, currency: string, locale?: string): string {
  return formatMoney((Number.isFinite(amountMinor) ? amountMinor : 0) / 100, currency, locale);
}

/**
 * FHS-614: just the symbol, e.g. "GBP" → "£", "USD" → "$", "AED" → "د.إ".
 *
 * For the one place a full formatted string will not do: the ± amount stepper,
 * where the number lives in an editable input and only the prefix beside it is
 * ours to write. Everything that merely displays an amount should use
 * {@link formatMoney} instead, so placement and separators stay the viewer's.
 *
 * Falls back to the code itself, which is what every screen showed before this.
 */
export function currencySymbol(currency: string, locale?: string): string {
  try {
    // Deliberately the DEFAULT currencyDisplay, matching formatMoney above.
    // 'narrowSymbol' would render CAD and AUD as a bare "$", so a Canadian
    // family would read "$" beside the stepper and "CA$" everywhere else on
    // the same screen: an ambiguous, USD-looking prefix in the one place the
    // number is being edited.
    const parts = new Intl.NumberFormat(locale ?? viewerLocale(), {
      style: 'currency',
      currency,
    }).formatToParts(0);
    return parts.find((part) => part.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

/** The default currency when an API response carries none: matches the database default. */
export const FALLBACK_CURRENCY = 'USD';

/**
 * How many decimal places a currency is written with: 2 for most, 0 for the
 * yen and the won, 3 for the Kuwaiti dinar.
 */
export function currencyDecimals(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * FHS-515 / FHS-636: whether the sticker economy can render this currency
 * correctly today.
 *
 * Every amount is stored as a whole number of the currency's smallest unit and
 * divided by 100 to show, and the amount stepper moves in quarter units. That
 * is only true for a 2-decimal currency: 500 yen would show as "5", because the
 * yen has no smaller unit to divide by.
 *
 * The currency picker has filtered its list this way since FHS-515, so no
 * family can choose one through the app. This is the same rule for the server,
 * which until FHS-636 accepted any three uppercase letters and would happily
 * store a currency every screen then renders a hundred times too small.
 *
 * Remove this fence when the economy stops assuming two decimals, not before.
 */
export function isSupportedCurrency(currency: string): boolean {
  if (!/^[A-Z]{3}$/.test(currency)) return false;
  // Review finding: Intl does not reject a well-formed code it has never heard
  // of. `Intl.NumberFormat('en', { currency: 'ZZZ' })` happily reports two
  // decimals, so the decimal check alone would have waved "ZZZ" through and
  // every screen would then print the literal code where the symbol goes.
  if (!isRealCurrencyCode(currency)) return false;
  return currencyDecimals(currency) === 2;
}

/**
 * Whether this is an ISO 4217 code the runtime actually knows.
 *
 * Both the api (Node) and the browser ship full ICU, so both answer from the
 * same list. On a runtime too old for `Intl.supportedValuesOf` this returns
 * true and the decimal check alone decides, which is the behaviour before this
 * function existed: no worse than it was, never stricter than the caller can
 * verify.
 */
function isRealCurrencyCode(currency: string): boolean {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  if (typeof supported !== 'function') return true;
  try {
    return supported('currency').includes(currency);
  } catch {
    return true;
  }
}

/** Plain-words reason for a refusal, used by the api and worth showing as-is. */
export const UNSUPPORTED_CURRENCY_MESSAGE =
  'Family Hub cannot show that currency correctly yet, so it cannot be set. Currencies with no small change (like the yen) or three decimal places (like the dinar) need work we have not done.';

/**
 * FHS-636: the one currency schema, used by every api route that accepts one.
 * It lived in two routes as identical copies, each with a comment pointing at
 * the other, which is how two copies stay identical right up until they don't.
 */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO 4217 code')
  .refine(isSupportedCurrency, { message: UNSUPPORTED_CURRENCY_MESSAGE });
