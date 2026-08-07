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
