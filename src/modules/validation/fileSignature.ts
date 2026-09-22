/** Real file-type detection from magic bytes, not the filename extension —
 * a renamed .exe would otherwise pass an extension-only check. */

export type DetectedFileKind = 'pdf' | 'jpeg' | 'png'

const SIGNATURES: { kind: DetectedFileKind; bytes: number[] }[] = [
  { kind: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { kind: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
  { kind: 'png', bytes: [0x89, 0x50, 0x4e, 0x47] },
]

export async function detectFileKind(file: File): Promise<DetectedFileKind | null> {
  const header = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  for (const { kind, bytes } of SIGNATURES) {
    if (bytes.every((b, i) => header[i] === b)) return kind
  }
  return null
}
