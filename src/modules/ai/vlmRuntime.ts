import {
  AutoProcessor,
  AutoModelForImageTextToText,
  env,
  type Processor,
  type PreTrainedModel,
} from '@huggingface/transformers'

// Zero-egress enforcement (gap-fix #3): the model must load from this app's
// own origin (public/models/, bundled at build time) and NEVER reach out to
// huggingface.co or any other host. Both flags below are what actually make
// that true at runtime, not just a claim in a README.
env.allowRemoteModels = false
env.allowLocalModels = true
env.localModelPath = '/models/'

// smolvlm-256m-instruct was tried and reverted (2026-09-27) — see
// PROJECT_LOG.md for the full measurement. Short version: it was
// sometimes meaningfully faster (171s vs a 386s baseline) but on two
// separate real test receipts it failed to produce usable structured
// output at all — one run invented an entirely different JSON schema
// the prompt never asked for, the other degenerated into a malformed,
// repeating hallucination loop that never even closed valid JSON. A
// faster pipeline that can't reliably extract data is strictly worse
// than a slower one that works, so this stays on the 500M model.
const MODEL_ID = 'smolvlm-500m-instruct'

const DTYPE_CONFIG = {
  vision_encoder: 'int8',
  embed_tokens: 'int8',
  decoder_model_merged: 'int8',
} as const

export interface VlmPipeline {
  processor: Processor
  model: PreTrainedModel
  device: 'webgpu' | 'wasm'
}

let loadPromise: Promise<VlmPipeline> | null = null

async function resolveDevice(): Promise<'webgpu' | 'wasm'> {
  const gpu = (navigator as Navigator & { gpu?: unknown }).gpu
  if (!gpu) return 'wasm'
  try {
    const adapter = await (gpu as { requestAdapter: () => Promise<unknown> }).requestAdapter()
    return adapter ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

/** Lazily loads the on-device VLM exactly once per session and reuses it —
 * loading is the expensive part (reads the bundled ONNX weights from
 * same-origin storage into a runtime session), inference on an
 * already-loaded model is much cheaper. */
export async function getVlm(): Promise<VlmPipeline> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const device = await resolveDevice()
      const [processor, model] = await Promise.all([
        AutoProcessor.from_pretrained(MODEL_ID),
        AutoModelForImageTextToText.from_pretrained(MODEL_ID, {
          device,
          dtype: DTYPE_CONFIG,
        }),
      ])
      return { processor, model, device }
    })()
  }
  return loadPromise
}

export function isVlmLoaded(): boolean {
  return loadPromise !== null
}
