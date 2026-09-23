import { createActor } from 'xstate'
import { orchestratorMachine, type OrchestratorInput, type BuiltResult } from './orchestratorMachine'
import type { ValidatedReceipt } from '../../modules/validation/validateExtraction'

export type OrchestratorPhase = 'processing' | 'ocr' | 'vlm' | 'building' | 'done' | 'failed'

export type OrchestratorResult =
  | { success: true; validated: ValidatedReceipt; built: BuiltResult }
  | { success: false; reason: string }

/** Orchestrator Agent — the single place that drives a receipt through the
 * whole pipeline (document processing → OCR/VLM extraction → classify →
 * reconcile → policy → claim), coordinating the other agents/modules
 * rather than leaving that sequencing scattered across the UI. The state
 * machine itself (orchestratorMachine.ts) is the only place in this
 * codebase using XState — every other agent stays a plain async function,
 * a deliberate scope decision from the original plan review.
 *
 * onPhaseChange lets the UI show progress without knowing anything about
 * XState's internal state names — it only ever sees the same small phase
 * vocabulary the UI already used before this phase existed. */
export function runOrchestrator(
  input: OrchestratorInput,
  onPhaseChange?: (phase: OrchestratorPhase) => void,
): Promise<OrchestratorResult> {
  return new Promise((resolve) => {
    const actor = createActor(orchestratorMachine, { input })
    let lastPhase: OrchestratorPhase | null = null

    actor.subscribe((snapshot) => {
      const phase = snapshot.context.phase
      if (phase !== lastPhase) {
        lastPhase = phase
        onPhaseChange?.(phase)
      }

      if (snapshot.status === 'done') {
        const ctx = snapshot.context
        if (ctx.phase === 'failed' || !ctx.validated || !ctx.built) {
          resolve({ success: false, reason: ctx.failureReason ?? 'Unknown orchestrator failure.' })
        } else {
          resolve({ success: true, validated: ctx.validated, built: ctx.built })
        }
      }
    })

    actor.start()
  })
}
