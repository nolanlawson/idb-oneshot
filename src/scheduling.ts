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
    try {
      origAdd(type, callback, options);
    } catch {
      // Node's native addEventListener may throw for objects with
      // handleEvent getter that throws. We still track it ourselves.
    }
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
 * Per spec, exceptions thrown by event handlers are caught and reported (not propagated),
 * and subsequent listeners continue to be called.
 *
 * @param target - The event target (e.g., IDBRequest)
 * @param ancestors - Ancestors from innermost to outermost (e.g., [transaction, database])
 * @param event - The event to dispatch
 * @returns true if preventDefault was NOT called
 */
export function idbDispatchEvent(target: EventTarget, ancestors: EventTarget[], event: Event): boolean {
  // Set event.target to the actual target
  Object.defineProperty(event, 'target', { value: target, configurable: true });

  // Track whether any listener threw an exception
  let exceptionThrown = false;

  // Capture phase: outermost to innermost ancestors
  for (let i = ancestors.length - 1; i >= 0; i--) {
    if (event.cancelBubble) break;
    if (invokeListeners(ancestors[i], event, 'capture')) exceptionThrown = true;
  }

  // Target phase: invoke tracked listeners directly (not via native dispatchEvent)
  // This gives us consistent try/catch exception handling.
  if (!event.cancelBubble) {
    if (invokeTargetListeners(target, event)) exceptionThrown = true;
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
      if (invokeListeners(ancestors[i], event, 'bubble')) exceptionThrown = true;
    }
  }

  // Store exception flag on the event for callers to check
  (event as any)._exceptionThrown = exceptionThrown;

  return !event.defaultPrevented;
}

/**
 * Invoke tracked listeners on a target for a given event and phase.
 * Exceptions thrown by listeners are caught and reported, but do not
 * prevent subsequent listeners from being called (per IDB spec).
 *
 * @returns true if any listener threw an exception
 */
function invokeListeners(
  target: EventTarget,
  event: Event,
  phase: 'capture' | 'bubble'
): boolean {
  const listeners = listenerMap.get(target);
  if (!listeners) return false;
  const type = event.type;
  let threw = false;

  for (const listener of [...listeners]) {
    if (event.cancelBubble) break;
    if (listener.type !== type) continue;
    if (phase === 'capture' && !listener.capture) continue;
    if (phase === 'bubble' && listener.capture) continue;

    if (listener.once) {
      const idx = listeners.findIndex(l => l === listener);
      if (idx !== -1) listeners.splice(idx, 1);
      // Also remove from the underlying EventTarget
      target.removeEventListener(type, listener.callback, { capture: listener.capture });
    }

    try {
      const fn = typeof listener.callback === 'function'
        ? listener.callback
        : listener.callback.handleEvent.bind(listener.callback);
      fn.call(target, event);
    } catch (e) {
      threw = true;
      // Report the error asynchronously (like the browser does for uncaught exceptions
      // in event handlers), but don't stop subsequent listeners.
      reportListenerException(e);
    }
  }
  return threw;
}

/**
 * Invoke listeners in the target phase (both capture and non-capture,
 * plus the on* handler). This replaces the native dispatchEvent call
 * so we can wrap each listener in try/catch.
 *
 * @returns true if any listener threw an exception
 */
function invokeTargetListeners(target: EventTarget, event: Event): boolean {
  const listeners = listenerMap.get(target);
  if (!listeners) return false;
  const type = event.type;
  let threw = false;

  // In target phase, add on* handler temporarily
  const handler = (target as any)['on' + type];
  if (typeof handler === 'function') {
    listeners.push({ type, callback: handler, capture: false, once: true });
  }

  // In target phase, both capture and non-capture listeners fire (in registration order)
  for (const listener of [...listeners]) {
    if (event.cancelBubble) break;
    if (listener.type !== type) continue;

    if (listener.once) {
      const idx = listeners.findIndex(l => l === listener);
      if (idx !== -1) listeners.splice(idx, 1);
      // Also remove from the underlying EventTarget
      target.removeEventListener(type, listener.callback, { capture: listener.capture });
    }

    try {
      const fn = typeof listener.callback === 'function'
        ? listener.callback
        : listener.callback.handleEvent.bind(listener.callback);
      fn.call(target, event);
    } catch (e) {
      threw = true;
      reportListenerException(e);
    }
  }
  return threw;
}

/**
 * Report an exception thrown by an event listener.
 * In a browser, this would fire a global 'error' event on window.
 * In Node, we silently swallow it — the IDB spec says exceptions
 * during event dispatch are "reported" but should not crash the process.
 * The test harness uses setup({allow_uncaught_exception: true}) for these.
 */
function reportListenerException(_e: unknown): void {
  // Silently swallow — the IDB spec behavior is to abort the transaction
  // (which we handle in _dispatchRequestEvent), not to crash the process.
}
