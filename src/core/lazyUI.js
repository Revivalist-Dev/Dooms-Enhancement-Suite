/**
 * Deferred settings-UI loader.
 *
 * template.html (~165KB) contains ONLY modal UI — the settings popup and the
 * other DES dialogs (system/notification logs, character sheet, tracker and
 * prompts editors, lorebook modal, workshop, roster). None of it is needed
 * for normal chat rendering, so instead of parsing it and binding/populating
 * its ~800 controls at startup, index.js registers an initializer here and
 * every "open a DES modal" entry point awaits ensureSettingsUI() first.
 *
 * Lives in its own module (rather than index.js) so leaf modules like
 * portraitBar can import it without creating an import cycle.
 */

let _initializer = null;
let _ready = null;

/**
 * Registers the function that loads template.html and runs all
 * template-dependent setup. Called once from index.js during init.
 * @param {() => Promise<void>} fn
 */
export function registerSettingsUIInitializer(fn) {
    _initializer = fn;
}

/**
 * Loads the settings UI if it hasn't been loaded yet. Safe to call from any
 * modal-opening code path; concurrent and repeat calls share one promise.
 * @returns {Promise<void>}
 */
export function ensureSettingsUI() {
    if (!_ready) {
        if (!_initializer) {
            return Promise.reject(new Error('[Dooms Tracker] Settings UI initializer not registered'));
        }
        _ready = Promise.resolve().then(_initializer).catch((e) => {
            console.error('[Dooms Tracker] Deferred settings UI failed to load:', e);
            _ready = null; // allow retry on next open attempt
            throw e;
        });
    }
    return _ready;
}

/** Whether the deferred settings UI has been (or is being) loaded. */
export function isSettingsUILoaded() {
    return _ready !== null;
}
