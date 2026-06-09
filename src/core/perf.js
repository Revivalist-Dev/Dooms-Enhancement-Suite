/**
 * Lightweight performance instrumentation.
 * No-op unless `localStorage.doomsPerfDebug` is set, so it costs nothing in production.
 *
 * Usage:
 *   import { perfMark, perfMeasure } from './core/perf.js';
 *   perfMark('portraitBar:render:start');
 *   ...work...
 *   perfMeasure('portraitBar:render', 'portraitBar:render:start');
 */

const PREFIX = 'dooms:';

function enabled() {
    try {
        return !!localStorage.getItem('doomsPerfDebug');
    } catch {
        return false;
    }
}

export function perfMark(name) {
    if (!enabled()) return;
    performance.mark(PREFIX + name);
}

export function perfMeasure(name, startMark) {
    if (!enabled()) return;
    try {
        const measure = performance.measure(PREFIX + name, PREFIX + startMark);
        console.debug(`[Dooms Perf] ${name}: ${measure.duration.toFixed(1)}ms`);
    } catch {
        // start mark missing — ignore
    }
}
