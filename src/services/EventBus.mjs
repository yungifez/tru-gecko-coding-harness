export class EventBus {
  constructor() {
    this.listeners = new Set();
  }

  publish(event) {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
