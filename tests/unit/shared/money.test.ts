import { describe, it, expect } from 'vitest';
import {
  FALLBACK_CURRENCY,
  currencyDecimals,
  currencySymbol,
  isSupportedCurrency,
  formatMoney,
  formatMoneyMinor,
  viewerLocale,
} from '../../../packages/shared/src/money.js';

// FHS-613: one money formatter for the whole product. Before it, every screen
// glued the currency code onto a number, which only ever looked right for
// codes that sit in front with a space.

describe('formatMoney', () => {
  it('writes each currency the way its locale writes it', () => {
    // A symbol in front, no space.
    expect(formatMoney(7.5, 'USD', 'en-US')).toBe('$7.50');
    expect(formatMoney(7.5, 'GBP', 'en-GB')).toBe('£7.50');
    // A code in front with a space.
    expect(formatMoney(7.5, 'AED', 'en-AE')).toContain('7.50');
    expect(formatMoney(7.5, 'AED', 'en-AE')).toMatch(/AED|د.إ/);
    // A symbol AFTER the number, with a comma for the decimal point. This is
    // the case a hand-built "EUR 7.50" gets wrong.
    const eur = formatMoney(7.5, 'EUR', 'de-DE');
    expect(eur).toContain('7,50');
    expect(eur).toContain('€');
    expect(eur.indexOf('€')).toBeGreaterThan(eur.indexOf('7'));
  });

  it('groups digits per the locale', () => {
    expect(formatMoney(1234.5, 'USD', 'en-US')).toBe('$1,234.50');
    expect(formatMoney(1234.5, 'EUR', 'de-DE')).toContain('1.234,50');
  });

  it('never blanks a figure on a bad currency code', () => {
    expect(formatMoney(7.5, 'NOTACODE', 'en-US')).toBe('NOTACODE 7.50');
  });

  it('treats a missing or broken amount as zero rather than showing NaN', () => {
    expect(formatMoney(Number.NaN, 'USD', 'en-US')).toBe('$0.00');
    expect(formatMoney(Number.POSITIVE_INFINITY, 'USD', 'en-US')).toBe('$0.00');
  });

  it('handles negative amounts', () => {
    expect(formatMoney(-2.25, 'USD', 'en-US')).toBe('-$2.25');
  });

  it('converts minor units for the stored rates', () => {
    expect(formatMoneyMinor(150, 'USD', 'en-US')).toBe('$1.50');
    expect(formatMoneyMinor(50, 'GBP', 'en-GB')).toBe('£0.50');
    expect(formatMoneyMinor(Number.NaN, 'USD', 'en-US')).toBe('$0.00');
  });

  it('falls back to the runtime locale when none is given', () => {
    // No locale stored anywhere, so the viewer's own device decides. Under
    // jsdom that is a real navigator.language.
    expect(() => formatMoney(1, 'USD')).not.toThrow();
    const locale = viewerLocale();
    expect(locale === undefined || typeof locale === 'string').toBe(true);
  });
});

// FHS-614: the symbol on its own, for the one control that cannot use a whole
// formatted string (the ± amount stepper, where the number stays editable).

describe('currencySymbol', () => {
  it('gives the symbol a family expects to see beside a number', () => {
    expect(currencySymbol('GBP', 'en-GB')).toBe('£');
    expect(currencySymbol('USD', 'en-US')).toBe('$');
    expect(currencySymbol('EUR', 'de-DE')).toBe('€');
  });

  it('falls back to the code rather than showing nothing', () => {
    expect(currencySymbol('NOTACODE', 'en-US')).toBe('NOTACODE');
  });
});

describe('FALLBACK_CURRENCY', () => {
  it('matches the database default, so no screen disagrees with another', () => {
    // The Admin Panel used to fall back to AED while everything else and the
    // tenants table defaulted to USD, so one screen quietly priced a family's
    // money in the wrong currency (FHS-614).
    expect(FALLBACK_CURRENCY).toBe('USD');
  });
});

// FHS-515 / FHS-636: which currencies the sticker economy can actually render.

describe('isSupportedCurrency', () => {
  it('accepts the ordinary two-decimal currencies', () => {
    for (const code of ['USD', 'GBP', 'EUR', 'AED', 'NGN', 'INR']) {
      expect(isSupportedCurrency(code)).toBe(true);
    }
  });

  it('refuses currencies with no small change', () => {
    // Every amount is stored in the smallest unit and divided by 100, so 500
    // yen would read as 5. The picker has refused these since FHS-515; FHS-636
    // made the server agree.
    expect(isSupportedCurrency('JPY')).toBe(false);
    expect(isSupportedCurrency('KRW')).toBe(false);
  });

  it('refuses three-decimal currencies for the same reason', () => {
    expect(isSupportedCurrency('KWD')).toBe(false);
    expect(isSupportedCurrency('BHD')).toBe(false);
  });

  it('refuses anything that is not a currency code', () => {
    expect(isSupportedCurrency('usd')).toBe(false);
    expect(isSupportedCurrency('POUNDS')).toBe(false);
    expect(isSupportedCurrency('')).toBe(false);
  });

  it('refuses a code that only LOOKS like a currency', () => {
    // Review finding: Intl reports two decimals for any well-formed code it
    // has never heard of, so the decimal check alone said yes to these.
    expect(isSupportedCurrency('ZZZ')).toBe(false);
    expect(isSupportedCurrency('XXX')).toBe(false);
    expect(isSupportedCurrency('AAA')).toBe(false);
  });
});

describe('currencyDecimals', () => {
  it('knows how many decimals each currency is written with', () => {
    expect(currencyDecimals('USD')).toBe(2);
    expect(currencyDecimals('JPY')).toBe(0);
    expect(currencyDecimals('KWD')).toBe(3);
  });

  it('assumes two for anything it does not recognise', () => {
    expect(currencyDecimals('NOTACODE')).toBe(2);
  });
});
