/** Only the SQL backend uses this, and that backend does not exist here. */
export class AsyncLocalStorage<T> {
  private store: T | undefined
  getStore(): T | undefined {
    return this.store
  }
  run<R>(store: T, callback: () => R): R {
    const previous = this.store
    this.store = store
    try {
      return callback()
    } finally {
      this.store = previous
    }
  }
}
