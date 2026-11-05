// Receipt dates come in every local format. Found in the pre-submission
// audit: `new Date('12-03-2026')` is 3 December in JavaScript, while a
// receipt from India or Europe means 12 March, so trip matching silently
// failed for day-first dates; `13/03/2026` didn't parse at all, and OCR
// never read written-out dates ("12 Mar 2026") in the first place. Every
// agent now reads dates through this one module.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_NAME = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)'

/** What OCR looks for: ISO, numeric day/month either way round with / - or
 * . separators, and written-out months in either order. */
export const RECEIPT_DATE_PATTERN = new RegExp(
  [
    '\\d{4}-\\d{2}-\\d{2}',
    '\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}',
    `\\d{1,2}[\\s-]+${MONTH_NAME}\\.?[\\s,-]+\\d{2,4}`,
    `${MONTH_NAME}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{2,4}`,
  ]
    .map((p) => `\\b${p}\\b`)
    .join('|'),
  'i',
)

function utc(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day))
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? d : null
}

const fullYear = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y))
const monthIndex = (name: string) => MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1

/** Every calendar date the printed text could mean: one for an
 * unambiguous date, two for 03/04/2026 (4 March or 3 April), none for
 * something that isn't a real date. */
export function dateReadings(raw: string | null): Date[] {
  if (!raw) return []
  const text = raw.trim()

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (iso) return [utc(+iso[1], +iso[2], +iso[3])].filter((d): d is Date => d !== null)

  const numeric = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/)
  if (numeric) {
    const year = fullYear(numeric[3])
    const a = +numeric[1]
    const b = +numeric[2]
    const readings = [utc(year, a, b) /* M/D */, utc(year, b, a) /* D/M */].filter((d): d is Date => d !== null)
    return readings.filter((d, i) => readings.findIndex((o) => o.getTime() === d.getTime()) === i)
  }

  const dayFirst = text.match(new RegExp(`^(\\d{1,2})[\\s-]+${MONTH_NAME}\\.?[\\s,-]+(\\d{2,4})$`, 'i'))
  if (dayFirst) return [utc(fullYear(dayFirst[3]), monthIndex(dayFirst[2]), +dayFirst[1])].filter((d): d is Date => d !== null)

  const monthFirst = text.match(new RegExp(`^${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{2,4})$`, 'i'))
  if (monthFirst) return [utc(fullYear(monthFirst[3]), monthIndex(monthFirst[1]), +monthFirst[2])].filter((d): d is Date => d !== null)

  return []
}

const toIso = (d: Date) => d.toISOString().slice(0, 10)

/** Stores a date as YYYY-MM-DD whenever only one reading is possible, so
 * the claim, the export and every later check agree on it. An ambiguous
 * date (03/04/2026) is kept exactly as printed for the reviewer, and the
 * checks consider both readings rather than guessing one. */
export function normalizeReceiptDate(raw: string | null): string | null {
  if (!raw) return raw
  const readings = dateReadings(raw)
  return readings.length === 1 ? toIso(readings[0]) : raw.trim()
}
