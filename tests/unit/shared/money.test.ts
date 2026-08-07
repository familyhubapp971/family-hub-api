import { describe, it, expect } from 'vitest';
import { formatMoney, formatMoneyMinor, viewerLocale } from '../../../packages/shared/src/money.js';

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
