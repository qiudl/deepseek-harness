import { createNativeMemoryStorage } from './native-storage.ts'

// This entry is bundled only into the App's sandboxed srcdoc. No browser disk storage.
if (import.meta.env.MODE !== 'native' || window.parent === window) throw Error('native frame requires its App parent')
document.documentElement.dataset.dshNative = 'true'
for (const name of ['localStorage', 'sessionStorage']) {
  Object.defineProperty(globalThis, name, { value: createNativeMemoryStorage(), configurable: false })
}
