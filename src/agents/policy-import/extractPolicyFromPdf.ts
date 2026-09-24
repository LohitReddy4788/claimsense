import { detectFileKind } from '../../modules/validation/fileSignature'
import { renderPdfPages } from '../../modules/document-processing/processDocument'
import { extractPolicyPage } from '../extraction/extractReceipt'
import type { PolicyRuleCandidate } from '../../types/extraction'

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
}

export type PolicyImportResult =
  | { success: true; candidates: PolicyRuleCandidate[]; pagesRead: number; totalPageCount: number }
  | { success: false; reason: string }

/** Policy-PDF import (Company Policies panel, built at the user's request
 * after they asked whether policy limits could be auto-filled from an
 * uploaded PDF instead of typed by hand). Deliberately does NOT save
 * anything to the policies table itself — every candidate rule it finds
 * is returned for the Policies panel to show as an individually
 * confirmable suggestion. This is a considered choice, not a missing
 * feature: a receipt extraction that's wrong gets caught by the human
 * review already built into the claim workflow, but a wrong POLICY LIMIT
 * would silently become the rule every future receipt gets checked
 * against with nothing downstream to catch a bad number — so unlike
 * receipt extraction, this never writes anything without an explicit,
 * per-rule human confirmation. */
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

  const allCandidates: PolicyRuleCandidate[] = []
  for (let i = 0; i < rendered.pages.length; i++) {
    onProgress?.({ pageNumber: i + 1, pagesToRead: rendered.pages.length })
    const result = await extractPolicyPage(rendered.pages[i])
    if (result.success) {
      allCandidates.push(...result.candidates)
    }
    // A single page failing to yield anything usable isn't treated as a
    // whole-import failure — the other pages may still have found real
    // candidates, and an empty page (e.g. a cover page) legitimately
    // produces zero rules. The import as a whole only fails if the PDF
    // itself couldn't even be rendered (handled above).
  }

  // Dedupe by category (case-insensitive), keeping the LAST occurrence —
  // if the same category is mentioned on more than one page, a later
  // page is more likely to be the specific rules section rather than an
  // earlier summary/overview mention.
  const byCategory = new Map<string, PolicyRuleCandidate>()
  for (const candidate of allCandidates) {
    byCategory.set(candidate.category.toLowerCase(), candidate)
  }

  return {
    success: true,
    candidates: [...byCategory.values()],
    pagesRead: rendered.pagesRendered,
    totalPageCount: rendered.totalPageCount,
  }
}
