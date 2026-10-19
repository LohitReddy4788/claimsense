import { setup, fromPromise, assign } from 'xstate'
import * as repo from '../../modules/storage/repository'
import { processDocument } from '../../modules/document-processing/processDocument'
import { extractReceipt } from '../extraction/extractReceipt'
import { validateExtraction } from '../../modules/validation/validateExtraction'
import { classifyCategory } from '../category/classifyCategory'
import { reconcileTravel } from '../travel/reconcileTravel'
import { evaluatePolicy } from '../../modules/policy/policyEngine'
import { populateClaim } from '../sheet/populateClaim'
import type { DetectedFileKind } from '../../modules/validation/fileSignature'
import type { ValidatedReceipt } from '../../modules/validation/validateExtraction'
import type { ClaimRecord } from '../../types/records'
import type { ReconciliationResult } from '../../types/reconciliation'
import type { PolicyCheckResult } from '../../types/policy'

// 1 initial attempt + 2 retries. Only applied to the two steps that touch
// something genuinely capable of a transient failure (rendering a PDF
// page, running OCR/the on-device model) — not to populateClaim's DB
// write, where a blind retry after a partial failure risks writing a
// duplicate claim. A populateClaim failure surfaces as 'failed' directly.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 500

const DEFAULT_POLICY_SETTINGS = { id: 'default' as const, baseCurrency: 'USD', rates: {} }

export interface OrchestratorInput {
  receiptId: string
  fileHash: string
  file: File
  kind: DetectedFileKind
  employeeId: string
}

export interface BuiltResult {
  category: ReturnType<typeof classifyCategory> | null
  reconciliation: ReconciliationResult | null
  policy: PolicyCheckResult | null
  claim: ClaimRecord | null
}

interface ProcessedDoc {
  blob: Blob
  width: number
  height: number
  pageCount?: number
}

interface OrchestratorContext extends OrchestratorInput {
  processAttempts: number
  extractAttempts: number
  processed: ProcessedDoc | null
  validated: ValidatedReceipt | null
  built: BuiltResult | null
  failureReason: string | null
  /** Which sub-step is currently running, for the UI to show progress
   * without needing to know XState's internal state names. */
  phase: 'processing' | 'ocr' | 'vlm' | 'building' | 'done' | 'failed'
}

export const orchestratorMachine = setup({
  types: {
    context: {} as OrchestratorContext,
    input: {} as OrchestratorInput,
  },
  actors: {
    processDoc: fromPromise(async ({ input }: { input: { file: File; kind: DetectedFileKind } }) => {
      const result = await processDocument(input.file, input.kind)
      if (!result.success) throw new Error(result.reason)
      return result satisfies ProcessedDoc
    }),
    extractData: fromPromise(
      async ({
        input,
      }: {
        input: { blob: Blob; onVlmStart: () => void }
      }): Promise<ValidatedReceipt> => {
        return validateExtraction(input.blob, () => {
          input.onVlmStart()
          return extractReceipt(input.blob)
        })
      },
    ),
    buildClaim: fromPromise(
      async ({
        input,
      }: {
        input: { receiptId: string; fileHash: string; employeeId: string; validated: ValidatedReceipt }
      }): Promise<BuiltResult> => {
        const { validated } = input
        if (!validated.data) {
          return { category: null, reconciliation: null, policy: null, claim: null }
        }
        const category = classifyCategory(validated.data)
        // Fetched fresh at build time, not cached — panels stay mounted all
        // session, so a travel request or policy added elsewhere after
        // this orchestrator started must still be seen (Phase 8's lesson).
        const [currentTravelRequests, currentPolicies, currentSettings] = await Promise.all([
          repo.listTravelRequests(),
          repo.listPolicies(),
          repo.getPolicySettings(),
        ])
        const reconciliation = reconcileTravel(validated.data, input.employeeId, currentTravelRequests)
        const policy = evaluatePolicy(
          validated.data,
          category.category,
          currentPolicies,
          currentSettings ?? DEFAULT_POLICY_SETTINGS,
        )
        const claim = await populateClaim({
          receiptId: input.receiptId,
          fileHash: input.fileHash,
          data: validated.data,
          extractionStatus: validated.status,
          category: category.category,
          reconciliation,
          policy,
        })
        return { category, reconciliation, policy, claim }
      },
    ),
  },
  guards: {
    canRetryProcess: ({ context }) => context.processAttempts < MAX_ATTEMPTS,
    canRetryExtract: ({ context }) => context.extractAttempts < MAX_ATTEMPTS,
  },
  delays: {
    retryDelay: RETRY_DELAY_MS,
  },
}).createMachine({
  id: 'receiptOrchestrator',
  context: ({ input }) => ({
    ...input,
    processAttempts: 0,
    extractAttempts: 0,
    processed: null,
    validated: null,
    built: null,
    failureReason: null,
    phase: 'processing',
  }),
  initial: 'processing',
  states: {
    processing: {
      entry: assign({
        processAttempts: ({ context }) => context.processAttempts + 1,
        phase: 'processing',
      }),
      invoke: {
        src: 'processDoc',
        input: ({ context }) => ({ file: context.file, kind: context.kind }),
        onDone: {
          target: 'extractingOcr',
          actions: assign({ processed: ({ event }) => event.output }),
        },
        onError: [
          { target: 'retryProcessing', guard: 'canRetryProcess' },
          {
            target: 'failed',
            actions: assign({
              failureReason: ({ event }) => `Document processing failed: ${(event.error as Error).message}`,
              phase: 'failed',
            }),
          },
        ],
      },
    },
    // A brief delay before retrying — a real transient failure (e.g. a
    // busy worker) is more likely to clear given a moment than an instant
    // retry, and it avoids hammering the same failing operation in a tight
    // loop.
    retryProcessing: {
      after: { retryDelay: 'processing' },
    },
    extractingOcr: {
      entry: assign({
        extractAttempts: ({ context }) => context.extractAttempts + 1,
        phase: 'ocr',
      }),
      invoke: {
        src: 'extractData',
        input: ({ context, self }) => ({
          blob: context.processed!.blob,
          onVlmStart: () => self.send({ type: 'VLM_STARTED' }),
        }),
        onDone: {
          target: 'building',
          actions: assign({ validated: ({ event }) => event.output }),
        },
        onError: [
          { target: 'retryExtracting', guard: 'canRetryExtract' },
          {
            target: 'failed',
            actions: assign({
              failureReason: ({ event }) => `Extraction failed: ${(event.error as Error).message}`,
              phase: 'failed',
            }),
          },
        ],
      },
      on: {
        VLM_STARTED: { actions: assign({ phase: 'vlm' }) },
      },
    },
    retryExtracting: {
      after: { retryDelay: 'extractingOcr' },
    },
    building: {
      entry: assign({ phase: 'building' }),
      invoke: {
        src: 'buildClaim',
        input: ({ context }) => ({
          receiptId: context.receiptId,
          fileHash: context.fileHash,
          employeeId: context.employeeId,
          validated: context.validated!,
        }),
        onDone: {
          target: 'done',
          actions: assign({ built: ({ event }) => event.output, phase: 'done' }),
        },
        onError: {
          target: 'failed',
          actions: assign({
            failureReason: ({ event }) => `Building claim failed: ${(event.error as Error).message}`,
            phase: 'failed',
          }),
        },
      },
    },
    done: { type: 'final' },
    failed: { type: 'final' },
  },
})
