// Event dispatch scheduling for IndexedDB
// Request results are computed synchronously (SQLite is sync),
// then events are dispatched asynchronously via setTimeout(0)

/**
 * Queue a microtask-like callback. Uses setTimeout(0) to match
 * the spec's task-based event dispatch model.
 */
export function queueTask(fn: () => void): void {
  setTimeout(fn, 0);
}

/**
 * Listener tracking for IDB event targets.
 * We track listeners ourselves so we can invoke them on ancestor nodes
 * with the correct event.target during capture/bubble phases.
 */
interface TrackedListener {
  type: string;
  callback: EventListener | EventListenerObject;
  capture: boolean;
  once: boolean;
}

const listenerMap = new WeakMap<EventTarget, TrackedListener[]>();

/**
 * Register an IDB event target for listener tracking.
 * Must be called in the constructor of IDB classes that participate in event propagation.
 */
export function initEventTarget(target: EventTarget): void {
  listenerMap.set(target, []);

  const origAdd = target.addEventListener.bind(target);
  const origRemove = target.removeEventListener.bind(target);

  target.addEventListener = function (
    type: string,
    callback: EventListener | EventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    if (!callback) return;
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    const once = typeof options === 'object' ? (options?.once ?? false) : false;
    const listeners = listenerMap.get(target)!;
    const exists = listeners.some(
      l => l.type === type && l.callback === callback && l.capture === capture
    );
    if (!exists) {
      listeners.push({ type, callback, capture, once });
    }
    origAdd(type, callback, options);
  };

  target.removeEventListener = function (
    type: string,
    callback: EventListener | EventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void {
    if (!callback) return;
    const capture = typeof options === 'boolean' ? options : (options?.capture ?? false);
    const listeners = listenerMap.get(target);
    if (listeners) {
      const idx = listeners.findIndex(
        l => l.type === type && l.callback === callback && l.capture === capture
      );
      if (idx !== -1) listeners.splice(idx, 1);
    }
    origRemove(type, callback, options);
  };
}

/**
 * Dispatch an event through the IDB event path with proper capture/target/bubble phases.
 *
 * @param target - The event target (e.g., IDBRequest)
 * @param ancestors - Ancestors from innermost to outermost (e.g., [transaction, database])
 * @param event - The event to dispatch
 * @returns true if preventDefault was NOT called
 */
export function idbDispatchEvent(target: EventTarget, ancestors: EventTarget[], event: Event): boolean {
  // Set event.target to the actual target
  Object.defineProperty(event, 'target', { value: target, configurable: true });

  // Capture phase: outermost to innermost ancestors
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (event.cancelBubble) break;
    invokeListeners(ancestors[i], event, 'capture');
  }

  // Target phase: fire on the target using dispatchEvent (sets event.target correctly)
  if (!event.cancelBubble) {
    // Temporarily add on* handler
    const handler = (target as any)['on' + event.type];
    if (typeof handler === 'function') {
      target.addEventListener(event.type, handler, { once: true });
    }
    // Use the base dispatchEvent to fire target-phase listeners
    // Mark to suppress our custom bubble logic
    (target as any)._suppressBubble = true;
    EventTarget.prototype.dispatchEvent.call(target, event);
    (target as any)._suppressBubble = false;
    if (typeof handler === 'function') {
      target.removeEventListener(event.type, handler);
    }
  }

  // Bubble phase: innermost to outermost ancestors
  if (event.bubbles && !event.cancelBubble) {
    for (let i = 0; i < ancestors.length; i++) {
      if (event.cancelBubble) break;
      // Temporarily add on* handler for bubble phase
      const ancestorHandler = (ancestors[i] as any)['on' + event.type];
      if (typeof ancestorHandler === 'function') {
        const listeners = listenerMap.get(ancestors[i]);
        // Add temporarily so it fires during invokeListeners
        if (listeners) {
          listeners.push({ type: event.type, callback: ancestorHandler, capture: false, once: true });
        }
      }
      invokeListeners(ancestors[i], event, 'bubble');
    }
  }

  return !event.defaultPrevented;
}

/**
 * Invoke tracked listeners on a target for a given event and phase.
 */
function invokeListeners(
  target: EventTarget,
  event: Event,
  phase: 'capture' | 'bubble'
): void {
  const listeners = listenerMap.get(target);
  if (!listeners) return;
  const type = event.type;

  for (const listener of [...listeners]) {
    if (event.cancelBubble) break;
    if (listener.type !== type) continue;
    if (phase === 'capture' && !listener.capture) continue;
    if (phase === 'bubble' && listener.capture) continue;

    const fn = typeof listener.callback === 'function'
      ? listener.callback
      : listener.callback.handleEvent.bind(listener.callback);

    if (listener.once) {
      const idx = listeners.findIndex(l => l === listener);
      if (idx !== -1) listeners.splice(idx, 1);
      // Also remove from the underlying EventTarget
      target.removeEventListener(type, listener.callback, { capture: listener.capture });
    }

    fn.call(target, event);
  }
}
