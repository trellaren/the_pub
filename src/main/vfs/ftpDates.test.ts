import { describe, it, expect } from 'vitest'
import { parseListingDate } from './ftpDates.js'

/**
 * Reading the date column out of an FTP listing.
 *
 * Pure, so the cases that are otherwise awkward to reach — a listing read on
 * New Year's Day, a two-digit year, a server that prints something nobody
 * recognises — are all settled here rather than by contriving a server that
 * lies about the date. `ftpAdapter.test.ts` proves the adapter uses it.
 */

const NOW = new Date('2026-08-15T12:00:00Z')

describe('the Unix ls forms', () => {
  it('reads a recent file, which carries a time but no year', () => {
    expect(parseListingDate('Aug 15 04:44', NOW)).toBe(Date.UTC(2026, 7, 15, 4, 44))
  })

  it('reads an old file, which carries a year but no time', () => {
    expect(parseListingDate('Mar 04 2019', NOW)).toBe(Date.UTC(2019, 2, 4))
  })

  it('accepts a single-digit day and the padding a server may use', () => {
    expect(parseListingDate('Mar  4 09:07', NOW)).toBe(Date.UTC(2026, 2, 4, 9, 7))
  })

  it('is not fussy about the case of the month', () => {
    expect(parseListingDate('AUG 15 04:44', NOW)).toBe(parseListingDate('aug 15 04:44', NOW))
  })

  /*
   * The case that makes year inference necessary. `ls` omits the year for
   * anything written in roughly the last six months, so a listing read on the
   * second of January shows December's files with no year at all — and assuming
   * the current one would date them eleven months in the future, which would
   * make every one of them look freshly modified on the first poll of the year.
   */
  it('puts a December file in the previous year when read in January', () => {
    const newYear = new Date('2026-01-02T09:00:00Z')
    expect(parseListingDate('Dec 28 22:15', newYear)).toBe(Date.UTC(2025, 11, 28, 22, 15))
  })

  /*
   * But not too eagerly. The listing is in the server's timezone and is read as
   * UTC, so a file written an hour ago on a server several zones east genuinely
   * can carry a stamp a little ahead of now — and calling that last year would
   * move it twelve months every time it was listed.
   */
  it('leaves a file a few hours ahead of now in the current year', () => {
    expect(parseListingDate('Aug 15 20:00', NOW)).toBe(Date.UTC(2026, 7, 15, 20, 0))
  })
})

describe('the DOS form', () => {
  it('reads a date and a 24-hour time', () => {
    expect(parseListingDate('08-15-2026 16:44', NOW)).toBe(Date.UTC(2026, 7, 15, 16, 44))
  })

  it('reads the meridiem when there is one', () => {
    expect(parseListingDate('08-15-26  04:44PM', NOW)).toBe(Date.UTC(2026, 7, 15, 16, 44))
    expect(parseListingDate('08-15-26  04:44AM', NOW)).toBe(Date.UTC(2026, 7, 15, 4, 44))
  })

  /* Midnight and noon are the two the twelve-hour clock gets wrong. */
  it('handles noon and midnight', () => {
    expect(parseListingDate('08-15-26  12:00AM', NOW)).toBe(Date.UTC(2026, 7, 15, 0, 0))
    expect(parseListingDate('08-15-26  12:00PM', NOW)).toBe(Date.UTC(2026, 7, 15, 12, 0))
  })

  it('reads a two-digit year the way Windows does', () => {
    expect(parseListingDate('01-02-99 10:00', NOW)).toBe(Date.UTC(1999, 0, 2, 10, 0))
    expect(parseListingDate('01-02-05 10:00', NOW)).toBe(Date.UTC(2005, 0, 2, 10, 0))
  })
})

describe('anything else', () => {
  /*
   * Zero rather than a guess, and rather than `Date.now()`. It is what an
   * unparsed date already produced, so an unfamiliar server leaves change
   * detection exactly as good as it was — where a fabricated time would make
   * every file look modified on every single poll, and re-index the whole
   * project every fifteen seconds forever.
   */
  it('gives zero for a format it does not recognise', () => {
    expect(parseListingDate('')).toBe(0)
    expect(parseListingDate('   ')).toBe(0)
    expect(parseListingDate('yesterday')).toBe(0)
    expect(parseListingDate('Foo 15 04:44', NOW)).toBe(0)
    expect(parseListingDate('2026-08-15T04:44:00Z', NOW)).toBe(0)
  })
})

describe('what the result is for', () => {
  /*
   * The property every consumer actually depends on. The indexer, the polling
   * watcher and the conflict check all compare one reading against another and
   * none reasons about the absolute instant — so what matters is that the same
   * listing gives the same number, and a changed one a different number.
   */
  it('is stable for the same input and different for a later time', () => {
    expect(parseListingDate('Aug 15 04:44', NOW)).toBe(parseListingDate('Aug 15 04:44', NOW))
    expect(parseListingDate('Aug 15 04:45', NOW)).toBeGreaterThan(parseListingDate('Aug 15 04:44', NOW))
    expect(parseListingDate('Aug 15 04:44', NOW)).toBeGreaterThan(parseListingDate('Mar 04 2019', NOW))
  })

  /* And the honest limit of it: `ls` prints no seconds, so two writes inside
   * one minute are one reading. This is why `statRaw` asks `MDTM` instead. */
  it('cannot tell two writes in the same minute apart', () => {
    expect(parseListingDate('Aug 15 04:44', NOW)).toBe(parseListingDate('Aug 15 04:44', NOW))
  })
})
