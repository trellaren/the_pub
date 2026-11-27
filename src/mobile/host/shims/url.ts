export function fileURLToPath(url: string | URL): string {
  return decodeURIComponent(new URL(url).pathname)
}
export function pathToFileURL(path: string): URL {
  return new URL(`file://${path.split('/').map(encodeURIComponent).join('/')}`)
}
export default { fileURLToPath, pathToFileURL }
