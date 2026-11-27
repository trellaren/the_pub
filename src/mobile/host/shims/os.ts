/** No figure is available to a page; zero reads as "unknown" to the one caller, which only uses it to advise on model sizes. */
export function totalmem(): number {
  return 0
}
export function tmpdir(): string {
  return '/tmp'
}
export function homedir(): string {
  return '/Documents'
}
export default { totalmem, tmpdir, homedir }
