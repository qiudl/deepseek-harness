/** Execute an authenticated Host injection under the App's script-hash policy.
 * @param text Classic script from the verified boot table.
 * @returns Completion after execution, with the temporary object URL released.
 */
export async function executeNativeScript(text: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
  const script = document.createElement('script')
  try {
    await new Promise<void>((resolve, reject) => {
      script.onload = () => { resolve() }
      script.onerror = () => { reject(new Error('native boot injection failed')) }
      script.src = url
      document.head.append(script)
    })
  } finally {
    script.remove()
    URL.revokeObjectURL(url)
  }
}
