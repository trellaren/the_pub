/**
 * Modification times out of an FTP directory listing.
 *
 * FTP has no single answer for this. A server that speaks MLSD reports an exact
 * timestamp and `basic-ftp` parses it for us; one that answers `LIST` — which is
 * most of them, and every server this project has been tested against — sends
 * the columns of a Unix `ls` listing, and the library hands that date back as
 * the raw string it found. Left unparsed it becomes a zero, and a project where
 * every file was modified at the epoch is one where nothing can tell that
 * anything has changed.
 *
 * Two things about the result are worth being plain about, because both would
 * be defects if anything relied on the opposite:
 *
 *  - **The resolution is a minute**, and for anything older than about six
 *    months a day, because that is all `ls` prints. Two writes inside the same
 *    minute are indistinguishable here.
 *  - **The timezone is unknown**, and these are read as UTC regardless. A
 *    listing is printed in the server's local time and never says which that is.
 *
 * Both are survivable because every consumer of an mtime in this codebase
 * *compares* them — the indexer diffs against what it stored, the watcher
 * diffs against the previous poll, the conflict check diffs against what the
 * editor last read. None reasons about the absolute instant, so a consistent
 * offset costs nothing. `FtpAdapter.statRaw` asks the server directly with
 * `MDTM` where an exact answer is worth a round trip.
 */

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec'
]

/** `Aug 15 04:44` or `Mar 04 2019` — the Unix `ls` forms. */
const UNIX = /^([a-z]{3})\s+(\d{1,2})\s+(?:(\d{1,2}):(\d{2})|(\d{4}))$/i

/** `08-15-26  04:44AM` — the form IIS and other DOS-lineage servers print. */
const DOS = /^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})\s*(am|pm)?$/i

/**
 * A listing date as milliseconds since the epoch, or 0 if it cannot be read.
 *
 * Zero rather than a guess: it is what an unparsed date already produced, so an
 * unfamiliar server format leaves change detection no worse than it was rather
 * than inventing a time that would make a file look modified when it was not.
 */
export function parseListingDate(raw: string, now = new Date()): number {
  const text = raw.trim()
  if (!text) return 0

  const unix = UNIX.exec(text)
  if (unix) {
    const month = MONTHS.indexOf(unix[1]!.toLowerCase())
    if (month < 0) return 0
    const day = Number(unix[2])
    if (unix[5]) return Date.UTC(Number(unix[5]), month, day)

    /*
     * No year in the recent form, so it has to be inferred. `ls` omits the year
     * for files within roughly the last six months, so the current one is
     * almost always right — except in the first days of January, when a file
     * from December would land eleven months in the future. Anything that comes
     * out ahead of now therefore belongs to the year before.
     */
    const stamp = Date.UTC(now.getUTCFullYear(), month, day, Number(unix[3]), Number(unix[4]))
    // A day of slack, because the listing is in the server's timezone and this
    // is read as UTC: a file written an hour ago on a server to the east would
    // otherwise look like next year's.
    return stamp > now.getTime() + 86_400_000
      ? Date.UTC(now.getUTCFullYear() - 1, month, day, Number(unix[3]), Number(unix[4]))
      : stamp
  }

  const dos = DOS.exec(text)
  if (dos) {
    const year = Number(dos[3])
    // Two-digit years: the same window Windows itself uses.
    const fullYear = year < 100 ? (year < 70 ? 2000 + year : 1900 + year) : year
    let hour = Number(dos[4])
    const meridiem = dos[6]?.toLowerCase()
    if (meridiem === 'pm' && hour !== 12) hour += 12
    if (meridiem === 'am' && hour === 12) hour = 0
    return Date.UTC(fullYear, Number(dos[1]) - 1, Number(dos[2]), hour, Number(dos[5]))
  }

  return 0
}
