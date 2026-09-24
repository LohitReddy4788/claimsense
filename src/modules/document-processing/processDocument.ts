import * as pdfjsLib from 'pdfjs-dist'
import type { DetectedFileKind } from '../validation/fileSignature'

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url,
).toString()

const MAX_DIMENSION = 1600 // keeps the extraction stage's input a consistent, bounded size
const RENDER_TIMEOUT_MS = 20_000 // safety net — a stalled render (e.g. an unusual browser state) fails cleanly instead of hanging the UI forever

class RenderTimeoutError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new RenderTimeoutError(`Timed out after ${ms}ms`)), ms),
    ),
  ])
}

export type ProcessResult =
  | { success: true; blob: Blob; width: number; height: number; pageCount: number }
  | { success: false; reason: string }

function scaleToFit(width: number, height: number): { width: number; height: number; scale: number } {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height))
  return { width: Math.round(width * scale), height: Math.round(height * scale), scale }
}

async function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Canvas produced no image data'))
    }, 'image/png')
  })
}

async function processPdf(file: File): Promise<ProcessResult> {
  try {
    const data = await file.arrayBuffer()
    const doc = await pdfjsLib.getDocument({ data }).promise
    const page = await doc.getPage(1)
    const baseViewport = page.getViewport({ scale: 1 })
    const { scale, width, height } = scaleToFit(baseViewport.width, baseViewport.height)
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return { success: false, reason: 'Canvas 2D context unavailable.' }

    // intent: 'print' skips pdf.js's requestAnimationFrame-driven render
    // scheduling (meant for interactive on-screen viewers) in favor of a
    // microtask loop. Without it, rendering silently stalls forever if the
    // browser tab is backgrounded mid-upload — found during Phase 4 testing.
    await withTimeout(
      page.render({ canvas, canvasContext: context, viewport, intent: 'print' }).promise,
      RENDER_TIMEOUT_MS,
    )
    const blob = await canvasToBlob(canvas)
    return { success: true, blob, width, height, pageCount: doc.numPages }
  } catch (e) {
    return {
      success: false,
      reason: `Could not render PDF (it may be corrupt): ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

async function processImage(file: File): Promise<ProcessResult> {
  try {
    const bitmap = await createImageBitmap(file)
    const { width, height } = scaleToFit(bitmap.width, bitmap.height)

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) return { success: false, reason: 'Canvas 2D context unavailable.' }

    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await canvasToBlob(canvas)
    return { success: true, blob, width, height, pageCount: 1 }
  } catch (e) {
    return {
      success: false,
      reason: `Could not process image (it may be corrupt): ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/** PDF/Image Processing Module — takes an already-validated receipt file
 * (Phase 3 accepted it) and produces one normalized, bounded-size PNG
 * that the extraction stage can consume, regardless of whether the
 * source was a PDF or a photo. Never throws — a corrupt file fails
 * cleanly with a reason, matching the plan's error-handling gap-fix. */
export async function processDocument(file: File, kind: DetectedFileKind): Promise<ProcessResult> {
  return kind === 'pdf' ? processPdf(file) : processImage(file)
}

export type MultiPageResult =
  | { success: true; pages: Blob[]; totalPageCount: number; pagesRendered: number }
  | { success: false; reason: string }

/** Renders up to `maxPages` pages of a PDF to individual bounded-size
 * PNGs, for the policy-PDF import flow (Company Policies panel) — a
 * receipt is always effectively one page, but a real policy document can
 * span several, and its spending-limit numbers could be on any of them.
 * Capped rather than unbounded: each page costs a real multi-minute
 * on-device AI read downstream, so an unbounded page count could turn one
 * upload into an effectively unusable wait. 3 pages covers the common
 * case (limits are almost always stated in an early summary section, not
 * buried deep in policy prose) while keeping worst-case wait time
 * bounded and predictable — the UI states this limit explicitly rather
 * than silently truncating. */
export async function renderPdfPages(file: File, maxPages: number): Promise<MultiPageResult> {
  try {
    const data = await file.arrayBuffer()
    const doc = await pdfjsLib.getDocument({ data }).promise
    const pagesToRender = Math.min(doc.numPages, maxPages)
    const pages: Blob[] = []

    for (let pageNum = 1; pageNum <= pagesToRender; pageNum++) {
      const page = await doc.getPage(pageNum)
      const baseViewport = page.getViewport({ scale: 1 })
      const { scale, width, height } = scaleToFit(baseViewport.width, baseViewport.height)
      const viewport = page.getViewport({ scale })

      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return { success: false, reason: 'Canvas 2D context unavailable.' }

      await withTimeout(
        page.render({ canvas, canvasContext: context, viewport, intent: 'print' }).promise,
        RENDER_TIMEOUT_MS,
      )
      pages.push(await canvasToBlob(canvas))
    }

    return { success: true, pages, totalPageCount: doc.numPages, pagesRendered: pagesToRender }
  } catch (e) {
    return {
      success: false,
      reason: `Could not render PDF (it may be corrupt): ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}
