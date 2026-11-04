/** Peak resident memory of the executable running a benchmark worker. */

import { readFileSync } from 'node:fs'

/**
 * Read peak resident memory for the current executable image.
 * @returns Peak resident memory in bytes.
 * @throws If Linux procfs does not provide a valid memory high-water mark.
 */
export function peakResidentSetBytes(): number {
  if (process.platform === 'linux') {
    // getrusage retains pre-exec RSS; VmHWM belongs to the current executable's memory map.
    const status = readFileSync('/proc/self/status', 'utf8')
    const match = /^VmHWM:\s+(\d+)\s+kB$/m.exec(status)
    const bytes = Number(match?.[1]) * 1024
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      throw new Error('Linux process status omits a valid VmHWM')
    }
    return bytes
  }
  return process.resourceUsage().maxRSS * 1024
}
