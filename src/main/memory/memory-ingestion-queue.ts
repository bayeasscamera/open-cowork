export class MemoryIngestionQueue {
  private readonly chains = new Map<string, Promise<void>>();

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) || Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    // Store the finally-wrapped promise so the identity check on cleanup
    // matches the object actually held in the map.
    const tracked = next.finally(() => {
      if (this.chains.get(key) === tracked) {
        this.chains.delete(key);
      }
    });
    this.chains.set(key, tracked);
    return next;
  }
}