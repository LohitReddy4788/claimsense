import { toExpenseCategory } from '../category/classifyCategory'
import { detectFileKind } from '../../modules/validation/fileSignature'
import { readPdfText, renderPdfPages } from '../../modules/document-processing/processDocument'
import { ocrImageText } from '../../modules/validation/ocrTextParser'
import { extractPolicyPage } from '../extraction/extractReceipt'
import { parsePolicyText } from './parsePolicyText'
import type { PolicyRateCandidate, PolicyRuleCandidate } from '../../types/extraction'

// A policy document's stated spending limits are almost always in an
// early summary/limits section, not buried deep in surrounding legal
// prose — capping here keeps worst-case wait time bounded and
// predictable (each page costs a real multi-minute on-device AI read)
// instead of turning one upload into an effectively unusable wait for a
// long document. Stated explicitly in the UI, not a silent truncation.
export const MAX_POLICY_PDF_PAGES = 3

export interface PolicyImportProgress {
  pageNumber: number
  pagesToRead: number
  method: PolicyReadMethod
}

/** How the limits were read: the PDF's own text (exact), OCR of the
 * rendered pages (scanned PDFs), or the on-device AI (last resort). */
export type PolicyReadMethod = 'text' | 'ocr' | 'ai'

export type PolicyImportResult =
  | {
      success: true
      candidates: PolicyRuleCandidate[]
      rates: PolicyRateCandidate[]
      method: PolicyReadMethod
      pagesRead: number
      totalPageCount: number
    }
  | { success: false; reason: string }

/** Policy-PDF import (Company Policies panel). Deliberately does NOT save
 * anything to the policies table itself — every candidate rule it finds
 * is returned for the Policies panel to show as an individually
 * confirmable suggestion. A wrong POLICY LIMIT would silently become the
 * rule every future receipt gets checked against with nothing downstream
 * to catch it, so this never writes anything without an explicit,
 * per-rule human confirmation.
 *
 * Same OCR-first design as receipts: the deterministic readers go first
 * (the PDF's text layer, then OCR for a scanned PDF), and the on-device
 * AI only reads the pages when neither found a limit. */
export async function extractPolicyFromPdf(
  file: File,
  onProgress?: (progress: PolicyImportProgress) => void,
): Promise<PolicyImportResult> {
  const kind = await detectFileKind(file)
  if (kind !== 'pdf') {
    return { success: false, reason: 'Only PDF files are supported for policy import (checked by file content, not the extension).' }
  }

  const rendered = await renderPdfPages(file, MAX_POLICY_PDF_PAGES)
  if (!rendered.success) {
    return { success: false, reason: rendered.reason }
  }
  const done = (method: PolicyReadMethod, candidates: PolicyRuleCandidate[], rates: PolicyRateCandidate[]): PolicyImportResult => ({
    success: true,
    candidates,
    rates,
    method,
    pagesRead: rendered.pagesRendered,
    totalPageCount: rendered.totalPageCount,
  })

  // 1. The PDF's own text: exact, instant.
  onProgress?.({ pageNumber: 1, pagesToRead: rendered.pages.length, method: 'text' })
  const fromText = parsePolicyText(await readPdfText(file, MAX_POLICY_PDF_PAGES))
  if (fromText.rules.length > 0) return done('text', fromText.rules, fromText.rates)

  // 2. OCR of each rendered page (a scanned policy has no text layer).
  const ocrLines: string[] = []
  for (let i = 0; i < rendered.pages.length; i++) {
    onProgress?.({ pageNumber: i + 1, pagesToRead: rendered.pages.length, method: 'ocr' })
    try {
      ocrLines.push(await ocrImageText(rendered.pages[i]))
    } catch (e) {
      console.warn('Policy OCR failed on page', i + 1, e)
    }
  }
  const fromOcr = parsePolicyText(ocrLines.join('\n'))
  if (fromOcr.rules.length > 0) return done('ocr', fromOcr.rules, fromOcr.rates)

  // 3. The on-device AI, page by page.
  const allCandidates: PolicyRuleCandidate[] = []
  for (let i = 0; i < rendered.pages.length; i++) {
    onProgress?.({ pageNumber: i + 1, pagesToRead: rendered.pages.length, method: 'ai' })
    const result = await extractPolicyPage(rendered.pages[i])
    if (result.success) {
      allCandidates.push(...result.candidates)
    }
    // A single page yielding nothing (a cover page, say) isn't a failure;
    // the other pages may still have found real candidates.
  }

  // Dedupe by category (case-insensitive), keeping the LAST occurrence —
  // a later page is more likely to be the specific rules section.
  // Names are mapped to the app's own categories first (a "Hotel" limit
  // saved as "Hotel" would never match a receipt, which are classified as
  // Lodging). A name that maps to nothing is kept as written, and the
  // panel says it won't match any receipt.
  const byCategory = new Map<string, PolicyRuleCandidate>()
  for (const candidate of allCandidates) {
    const mapped = toExpenseCategory(candidate.category)
    const normalized = mapped ? { ...candidate, category: mapped, writtenAs: candidate.category } : candidate
    byCategory.set(normalized.category.toLowerCase(), normalized)
  }

  // Rates found by text or OCR are still worth offering even when the
  // limits needed the AI.
  return done('ai', [...byCategory.values()], fromText.rates.length > 0 ? fromText.rates : fromOcr.rates)
}
