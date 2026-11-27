/**
 * A page cannot resolve names, and the one caller resolves them only to refuse
 * hosts that turn out to be on the local network. A name is therefore answered
 * with a public placeholder: the checks on the URL's own text still run, but a
 * public name that resolves to a private address is not caught here the way it
 * is on desktop.
 */
export async function lookup(_hostname: string, _options?: unknown): Promise<{ address: string; family: number }[]> {
  return [{ address: '93.184.216.34', family: 4 }]
}
export default { lookup }
