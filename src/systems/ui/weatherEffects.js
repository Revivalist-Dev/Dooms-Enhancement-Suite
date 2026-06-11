/**
 * Dynamic Weather Effects Module
 * Creates weather effects based on the Info Box weather field
 */

import { extensionSettings, lastGeneratedData, committedTrackerData } from '../../core/state.js';
import { repairJSON } from '../../utils/jsonRepair.js';
import { getParticleEngine } from './particleCanvas.js';
import { ensureCss } from '../../core/cssLoader.js';

let weatherContainer = null;
let currentWeatherType = null;
let currentTimeOfDay = null;
let currentHour = null;

/** Memoized weather-text -> weather-type lookups (the pattern scan is O(languages × patterns)) */
const weatherTypeCache = new Map();

/**
 * Parse time string to extract hour (24-hour format)
 * Supports formats like "3:00 PM", "15:00", "3 PM", "Evening", etc.
 */
function parseHourFromTime(timeStr) {
    if (!timeStr) return null;

    const text = timeStr.toLowerCase().trim();

    // Check for descriptive time words first
    if (text.includes('dawn') || text.includes('sunrise')) return 6;
    if (text.includes('early morning')) return 7;
    if (text.includes('morning')) return 9;
    if (text.includes('midday') || text.includes('noon') || text.includes('mid-day')) return 12;
    if (text.includes('afternoon')) return 14;
    if (text.includes('late afternoon')) return 16;
    if (text.includes('evening') || text.includes('dusk') || text.includes('sunset')) return 19;
    if (text.includes('twilight')) return 20;
    if (text.includes('night') || text.includes('nighttime')) return 22;
    if (text.includes('midnight')) return 0;
    if (text.includes('late night')) return 2;

    // Try to parse numeric time formats
    // Format: "3:00 PM" or "3:00PM" or "3 PM"
    const ampmMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
    if (ampmMatch) {
        let hour = parseInt(ampmMatch[1], 10);
        const isPM = ampmMatch[3].toLowerCase() === 'pm';
        if (isPM && hour !== 12) hour += 12;
        if (!isPM && hour === 12) hour = 0;
        return hour;
    }

    // Format: "15:00" (24-hour)
    const militaryMatch = text.match(/(\d{1,2}):(\d{2})/);
    if (militaryMatch) {
        return parseInt(militaryMatch[1], 10);
    }

    return null;
}

/**
 * Determine time of day based on hour
 */
function getTimeOfDay(hour) {
    if (hour === null) return 'unknown';

    // Night: 8 PM (20:00) to 5 AM (05:00)
    if (hour >= 20 || hour < 5) return 'night';

    // Dawn/Dusk: 5 AM - 7 AM and 6 PM - 8 PM
    if (hour >= 5 && hour < 7) return 'dawn';
    if (hour >= 18 && hour < 20) return 'dusk';

    // Day: 7 AM to 6 PM
    return 'day';
}

/**
 * Extract time from Info Box data
 */
function getCurrentTime() {
    const infoBoxData = lastGeneratedData.infoBox || committedTrackerData.infoBox || '';

    // Try to parse as JSON first (new format)
    try {
        const parsed = typeof infoBoxData === 'string' ? repairJSON(infoBoxData) : infoBoxData;
        if (parsed && parsed.time) {
            // Use the end time if available (current time), otherwise start time
            return parsed.time.end || parsed.time.start || null;
        }
    } catch (e) {
        // Not JSON, try old text format
    }

    // Fallback: Parse the old text format to find Time field
    const lines = infoBoxData.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Time:')) {
            const timeStr = trimmed.substring('Time:'.length).trim();
            // If it contains →, take the end time (after arrow)
            if (timeStr.includes('→')) {
                const parts = timeStr.split('→');
                return parts[1]?.trim() || parts[0]?.trim();
            }
            return timeStr;
        }
    }

    return null;
}

// Patterns for specific weather conditions (order matters - combined effects first)
// Grouped by languages for easy editing
// EXPORTED: Used by jsonPromptHelpers.js to provide valid weather keywords to LLM
export const WEATHER_PATTERNS_BY_LANGUAGE = {
    en: [
        { id: "blizzard", patterns: [ "blizzard" ] }, // Snow + Wind
        { id: "storm", patterns: [ "storm", "thunder", "lightning" ] }, // Rain + Lightning
        { id: "wind", patterns: [ "wind", "breeze", "gust", "gale" ] },
        { id: "snow", patterns: [ "snow", "flurries" ] },
        { id: "rain", patterns: [ "rain", "drizzle", "shower" ] },
        { id: "mist", patterns: [ "mist", "fog", "haze" ] },
        { id: "sunny", patterns: [ "sunny", "clear", "bright" ] },
        { id: "none", patterns: [ "cloud", "overcast", "indoor", "inside" ] },
    ],
    ru: [
        { id: "blizzard", patterns: [ "метель" ] },
        { id: "storm", patterns: [ "гроза", "буря", "шторм" ] },
        { id: "wind", patterns: [ "ветер", "ветрено", "ветерок", "бриз", "легкий бриз", "слегка ветрено", "легкий ветер", "шквал,буря" ] },
        { id: "snow", patterns: [ "снег", "снегопад" ] },
        { id: "rain", patterns: [ "дождь", "морось", "ливень" ] },
        { id: "mist", patterns: [ "мгла", "туман", "туманно" ] },
        { id: "sunny", patterns: [ "солнечно", "ясно", "ярко", "ясное утро", "ясный день" ] },
        { id: "none", patterns: [ "облачно", "пасмурно", "в помещении", "внутри" ] },
    ],
}

/**
 * Get valid weather keywords for LLM prompt injection.
 * Returns weather patterns for specified language or all languages.
 * This ensures LLM generates responses that exactly match our expected patterns.
 *
 * @param {string} [language] - Language code (e.g., 'en', 'ru'). If not specified, returns all languages.
 * @returns {Object} Object with weather type IDs as keys and arrays of valid keywords as values
 * @example
 * // Returns: { blizzard: ["blizzard"], storm: ["storm", "thunder", "lightning"], ... }
 * getWeatherKeywordsForPrompt('en');
 */
export function getWeatherKeywordsForPrompt(language) {
    const result = {};

    // Get patterns for specified language or merge all languages
    const languagesToProcess = language && WEATHER_PATTERNS_BY_LANGUAGE[language]
        ? { [language]: WEATHER_PATTERNS_BY_LANGUAGE[language] }
        : WEATHER_PATTERNS_BY_LANGUAGE;

    for (const [lang, patterns] of Object.entries(languagesToProcess)) {
        for (const { id, patterns: keywords } of patterns) {
            if (!result[id]) {
                result[id] = [];
            }
            // Add keywords, avoiding duplicates
            for (const keyword of keywords) {
                if (!result[id].includes(keyword)) {
                    result[id].push(keyword);
                }
            }
        }
    }

    return result;
}

/**
 * Get weather keywords as a formatted string for LLM instructions.
 * Provides a clear template showing valid weather forecast values.
 *
 * @param {string} [language] - Language code. If not specified, uses all available patterns.
 * @returns {string} Formatted string for prompt injection
 * @example
 * // Returns: 'Valid forecast values: "blizzard", "storm", "thunder", "lightning", "wind", ...'
 * getWeatherKeywordsAsPromptString('en');
 */
export function getWeatherKeywordsAsPromptString(language) {
    const keywords = getWeatherKeywordsForPrompt(language);
    const allKeywords = [];

    for (const patterns of Object.values(keywords)) {
        allKeywords.push(...patterns);
    }

    return `Valid forecast values (use one of these exactly): ${allKeywords.map(k => `"${k}"`).join(', ')}`;
}

/**
 * Parse weather text to determine effect type
 */
function parseWeatherType(weatherText) {
    if (!weatherText) return "none";

    const text = weatherText.toLowerCase();
    const cached = weatherTypeCache.get(text);
    if (cached !== undefined) return cached;

    let result = "none";
    outer:
    for (const language of Object.values(WEATHER_PATTERNS_BY_LANGUAGE)) {
        for (const { id, patterns } of language) {
            if (patterns.some(p => text.includes(p))) {
                result = id;
                break outer;
            }
        }
    }

    if (weatherTypeCache.size > 200) weatherTypeCache.clear(); // bound memory
    weatherTypeCache.set(text, result);
    return result;
}

/**
 * Extract weather from Info Box data
 */
function getCurrentWeather() {
    const infoBoxData = lastGeneratedData.infoBox || committedTrackerData.infoBox || '';

    // Try to parse as JSON first (new format)
    try {
        const parsed = typeof infoBoxData === 'string' ? repairJSON(infoBoxData) : infoBoxData;
        if (parsed && parsed.weather) {
            // Return the forecast text from the weather object
            return parsed.weather.forecast || parsed.weather.emoji || null;
        }
    } catch (e) {
        // Not JSON, try old text format
    }

    // Fallback: Parse the old text format to find Weather field
    const lines = infoBoxData.split('\n');
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('Weather:')) {
            return trimmed.substring('Weather:'.length).trim();
        }
    }

    return null;
}

// NOTE: snow / rain / mist / wind / star / firefly / dust-mote / light-orb
// particles are rendered by the shared canvas engine (particleCanvas.js) —
// one canvas + one rAF loop instead of up to ~100 individually CSS-animated
// DOM nodes. Only the low-count gradient overlays (sun, moon, glows,
// lightning, shooting star) remain as DOM elements below.

/**
 * Calculate sun position based on hour (arc across sky)
 * Returns { left: vw%, top: dvh% }
 */
function calculateSunPosition(hour) {
    // Daytime is roughly 5 AM to 8 PM (5-20)
    // Map hour to position along an arc
    // 5 AM = far left, low | 12 PM = center, high | 8 PM = far right, low

    if (hour === null) hour = 12; // Default to noon if unknown

    // Clamp to daytime hours
    const clampedHour = Math.max(5, Math.min(20, hour));

    // Normalize to 0-1 range (5 AM = 0, 20 PM = 1)
    const progress = (clampedHour - 5) / 15;

    // Horizontal position: 3% to 92% (left to right, wider range)
    const left = 3 + progress * 89;

    // Vertical position: parabolic arc (high at noon, low at dawn/dusk)
    // At progress 0.5 (noon), top should be ~8% (high)
    // At progress 0 or 1, top should be ~40% (low, near horizon)
    const normalizedProgress = (progress - 0.5) * 2; // -1 to 1
    const top = 8 + 32 * (normalizedProgress * normalizedProgress);

    return { left, top };
}

/**
 * Create clear/sunny weather overlays (sun, glow, ambient, lens flare).
 * Dust motes and light orbs render on the particle canvas.
 */
function createSunshine(hour) {
    const container = document.createElement('div');
    container.className = 'rpg-weather-particles rpg-clear-weather';

    // Create the sun based on current hour
    const sunPos = calculateSunPosition(hour);

    const sun = document.createElement('div');
    sun.className = 'rpg-weather-particle rpg-clear-sun';
    sun.style.left = `${sunPos.left}vw`;
    sun.style.top = `${sunPos.top}dvh`;
    container.appendChild(sun);

    // Create sun glow
    const sunGlow = document.createElement('div');
    sunGlow.className = 'rpg-weather-particle rpg-clear-sun-glow';
    sunGlow.style.left = `${sunPos.left}vw`;
    sunGlow.style.top = `${sunPos.top}dvh`;
    container.appendChild(sunGlow);

    // Create warm ambient glow overlay
    const ambientGlow = document.createElement('div');
    ambientGlow.className = 'rpg-weather-particle rpg-clear-ambient-glow';
    container.appendChild(ambientGlow);

    // Create lens flare effect in corner
    const lensFlare = document.createElement('div');
    lensFlare.className = 'rpg-weather-particle rpg-clear-lens-flare';
    container.appendChild(lensFlare);

    return container;
}

/**
 * Create sunrise effect (dawn - warm orange/pink sky gradient with low sun)
 */
function createSunrise(hour) {
    const container = document.createElement('div');
    container.className = 'rpg-weather-particles rpg-sunrise-weather';

    // Create sunrise gradient overlay
    const sunriseOverlay = document.createElement('div');
    sunriseOverlay.className = 'rpg-weather-particle rpg-sunrise-overlay';
    container.appendChild(sunriseOverlay);

    // Calculate sun position (rising from left horizon)
    const sunPos = calculateSunPosition(hour);

    // Create the rising sun
    const sun = document.createElement('div');
    sun.className = 'rpg-weather-particle rpg-clear-sun rpg-sunrise-sun';
    sun.style.left = `${sunPos.left}vw`;
    sun.style.top = `${sunPos.top}dvh`;
    container.appendChild(sun);

    // Create sun glow (more orange during sunrise)
    const sunGlow = document.createElement('div');
    sunGlow.className = 'rpg-weather-particle rpg-clear-sun-glow rpg-sunrise-glow';
    sunGlow.style.left = `${sunPos.left}vw`;
    sunGlow.style.top = `${sunPos.top}dvh`;
    container.appendChild(sunGlow);

    // Create horizon glow
    const horizonGlow = document.createElement('div');
    horizonGlow.className = 'rpg-weather-particle rpg-sunrise-horizon-glow';
    container.appendChild(horizonGlow);

    // Fading stars + golden dust motes render on the particle canvas

    return container;
}

/**
 * Create sunset effect (dusk - warm red/purple sky gradient with low sun)
 */
function createSunset(hour) {
    const container = document.createElement('div');
    container.className = 'rpg-weather-particles rpg-sunset-weather';

    // Create sunset gradient overlay
    const sunsetOverlay = document.createElement('div');
    sunsetOverlay.className = 'rpg-weather-particle rpg-sunset-overlay';
    container.appendChild(sunsetOverlay);

    // Calculate sun position (setting on right horizon)
    const sunPos = calculateSunPosition(hour);

    // Create the setting sun
    const sun = document.createElement('div');
    sun.className = 'rpg-weather-particle rpg-clear-sun rpg-sunset-sun';
    sun.style.left = `${sunPos.left}vw`;
    sun.style.top = `${sunPos.top}dvh`;
    container.appendChild(sun);

    // Create sun glow (more red during sunset)
    const sunGlow = document.createElement('div');
    sunGlow.className = 'rpg-weather-particle rpg-clear-sun-glow rpg-sunset-glow';
    sunGlow.style.left = `${sunPos.left}vw`;
    sunGlow.style.top = `${sunPos.top}dvh`;
    container.appendChild(sunGlow);

    // Create horizon glow
    const horizonGlow = document.createElement('div');
    horizonGlow.className = 'rpg-weather-particle rpg-sunset-horizon-glow';
    container.appendChild(horizonGlow);

    // Emerging stars + dust motes render on the particle canvas

    return container;
}

/**
 * Create clear nighttime weather effect with moon, stars, and fireflies
 */
function createNighttime(hour) {
    const container = document.createElement('div');
    container.className = 'rpg-weather-particles rpg-night-weather';

    // Create dark blue ambient overlay
    const nightOverlay = document.createElement('div');
    nightOverlay.className = 'rpg-weather-particle rpg-night-overlay';
    container.appendChild(nightOverlay);

    // Calculate moon position based on hour
    const moonPos = calculateMoonPosition(hour);

    // Create the moon
    const moon = document.createElement('div');
    moon.className = 'rpg-weather-particle rpg-night-moon';
    moon.style.left = `${moonPos.left}vw`;
    moon.style.top = `${moonPos.top}dvh`;
    container.appendChild(moon);

    // Create moon glow
    const moonGlow = document.createElement('div');
    moonGlow.className = 'rpg-weather-particle rpg-night-moon-glow';
    moonGlow.style.left = `${moonPos.left - 3}vw`;
    moonGlow.style.top = `${moonPos.top - 3}dvh`;
    container.appendChild(moonGlow);

    // Twinkling stars + fireflies render on the particle canvas

    // Create subtle shooting star occasionally
    const shootingStar = document.createElement('div');
    shootingStar.className = 'rpg-weather-particle rpg-night-shooting-star';
    container.appendChild(shootingStar);

    return container;
}

/**
 * Create lightning flash effect
 */
function createLightning() {
    const container = document.createElement('div');
    container.className = 'rpg-weather-particles';

    // Create lightning flash overlay
    const flash = document.createElement('div');
    flash.className = 'rpg-weather-particle rpg-lightning';
    container.appendChild(flash);

    return container;
}

/**
 * Calculate moon position based on hour (arc across sky at night)
 * Returns { left: vw%, top: dvh% }
 */
function calculateMoonPosition(hour) {
    // Nighttime is roughly 8 PM to 5 AM (20-5)
    // Map hour to position along an arc
    // 8 PM = far left, low | midnight = center-left, high | 5 AM = far right, low

    if (hour === null) hour = 0; // Default to midnight if unknown

    // Normalize night hours to 0-1 range
    // 20 (8 PM) = 0, 0 (midnight) = ~0.44, 5 (5 AM) = 1
    let progress;
    if (hour >= 20) {
        // 8 PM to midnight: 20-24 maps to 0-0.44
        progress = (hour - 20) / 9;
    } else {
        // Midnight to 5 AM: 0-5 maps to 0.44-1
        progress = (hour + 4) / 9;
    }

    // Horizontal position: 10% to 80% (left to right)
    const left = 10 + progress * 70;

    // Vertical position: parabolic arc (high at ~2 AM, low at dusk/dawn)
    // Peak should be around progress 0.67 (~2 AM)
    const peakProgress = 0.5;
    const normalizedProgress = (progress - peakProgress) * 2; // -1 to 1
    const top = 8 + 25 * (normalizedProgress * normalizedProgress);

    return { left, top };
}

/**
 * Update sun/moon position without recreating the whole effect
 */
function updateCelestialPosition(hour) {
    if (!weatherContainer) return false;

    // Update sun position if it exists
    const sun = weatherContainer.querySelector('.rpg-clear-sun');
    const sunGlow = weatherContainer.querySelector('.rpg-clear-sun-glow');

    if (sun && sunGlow) {
        const sunPos = calculateSunPosition(hour);
        sun.style.left = `${sunPos.left}vw`;
        sun.style.top = `${sunPos.top}dvh`;
        sunGlow.style.left = `${sunPos.left}vw`;
        sunGlow.style.top = `${sunPos.top}dvh`;
        return true;
    }

    // Update moon position if it exists
    const moon = weatherContainer.querySelector('.rpg-night-moon');
    const moonGlow = weatherContainer.querySelector('.rpg-night-moon-glow');

    if (moon && moonGlow) {
        const moonPos = calculateMoonPosition(hour);
        moon.style.left = `${moonPos.left}vw`;
        moon.style.top = `${moonPos.top}dvh`;
        moonGlow.style.left = `${moonPos.left - 3}vw`;
        moonGlow.style.top = `${moonPos.top - 3}dvh`;
        return true;
    }

    return false;
}

/**
 * Remove current weather effect
 */
function removeWeatherEffect() {
    getParticleEngine().setEffects(null);
    if (weatherContainer) {
        weatherContainer.remove();
        weatherContainer = null;
        currentWeatherType = null;
        currentTimeOfDay = null;
        currentHour = null;
    }
}

/**
 * Update weather effect based on current weather and time
 */
export function updateWeatherEffect() {
    // Check if dynamic weather is enabled
    if (!extensionSettings.enableDynamicWeather) {
        removeWeatherEffect();
        return;
    }
    const weather = getCurrentWeather();
    const weatherType = parseWeatherType(weather);

    // Get current time of day
    const timeStr = getCurrentTime();
    const hour = parseHourFromTime(timeStr);
    const timeOfDay = getTimeOfDay(hour);

    // If only the hour changed (same weather and time of day), just update celestial position
    if (weatherType === currentWeatherType && timeOfDay === currentTimeOfDay && hour !== currentHour) {
        if (updateCelestialPosition(hour)) {
            currentHour = hour;
            return; // Successfully updated position without recreating
        }
    }

    // Don't recreate if nothing has changed
    if (weatherType === currentWeatherType && timeOfDay === currentTimeOfDay && hour === currentHour) {
        return;
    }

    // Remove existing effect
    removeWeatherEffect();

    // Create new effect based on weather type
    if (weatherType === 'none') {
        return; // No effect
    }

    currentWeatherType = weatherType;
    currentTimeOfDay = timeOfDay;
    currentHour = hour;

    // Foreground mode paints particles OVER the chat — the old CSS dimmed
    // foreground stars/fireflies to keep text readable; opacityScale carries
    // that invariant onto the canvas.
    const fg = !!extensionSettings.weatherForeground;
    const dim = (scale) => (fg ? scale : 1);

    // Canvas effect plan + optional DOM overlay builder per weather type.
    // The DOM build is DEFERRED until styles/weather.css has loaded: before
    // that, .rpg-weather-particles has no position/z-index, so the container
    // forms no stacking context, the fixed canvas escapes to the root (and
    // can paint over chat even in background mode), and overlays render
    // unstyled.
    let canvasEffects = null;
    let buildOverlays = null;
    switch (weatherType) {
        case 'snow':
            canvasEffects = { snow: { count: 50 } };
            break;
        case 'rain':
            canvasEffects = { rain: { count: 100 } };
            break;
        case 'mist':
            canvasEffects = { mist: { count: 5 } };
            break;
        case 'sunny':
            // Use appropriate effect based on time of day
            if (timeOfDay === 'night') {
                buildOverlays = () => createNighttime(hour);
                canvasEffects = {
                    stars: { count: 68, opacityScale: dim(0.5) },
                    fireflies: { count: 15, opacityScale: dim(0.6) },
                };
            } else if (timeOfDay === 'dawn') {
                buildOverlays = () => createSunrise(hour);
                // Faint star remnants near the top of the dawn sky (the old
                // .rpg-sunrise-fading-star: opacity-capped, top 40dvh)
                canvasEffects = {
                    stars: { count: 15, maxOpacity: 0.45, band: 0.4, opacityScale: dim(0.5) },
                    dustMotes: { count: 12 },
                };
            } else if (timeOfDay === 'dusk') {
                buildOverlays = () => createSunset(hour);
                // Dim emerging stars (the old .rpg-sunset-emerging-star)
                canvasEffects = {
                    stars: { count: 20, maxOpacity: 0.8, band: 0.5, opacityScale: dim(0.5) },
                    dustMotes: { count: 12 },
                };
            } else {
                buildOverlays = () => createSunshine(hour);
                canvasEffects = { dustMotes: { count: 25 }, lightOrbs: { count: 6 } };
            }
            break;
        case 'wind':
            canvasEffects = { wind: { count: 30 } };
            break;
        case 'storm':
            // Storm = Rain + Lightning (lightning flash stays a DOM overlay)
            buildOverlays = () => createLightning();
            canvasEffects = { rain: { count: 100 } };
            break;
        case 'blizzard':
            // Blizzard = Snow + Wind
            canvasEffects = { snow: { count: 50 }, wind: { count: 30 } };
            break;
    }

    if (!canvasEffects) return;

    // Stale-token guard: if the weather changes again before the CSS
    // resolves, the older build silently aborts.
    const token = ++_buildToken;
    ensureCss('weather').then(() => {
        if (token !== _buildToken) return;                       // superseded
        if (!extensionSettings.enableDynamicWeather) return;      // toggled off meanwhile
        if (weatherContainer) return;                             // already built

        const container = buildOverlays ? buildOverlays() : null;
        const el = container || document.createElement('div');
        if (!container) el.className = 'rpg-weather-particles';

        // Apply z-index based on background/foreground settings
        if (extensionSettings.weatherForeground) {
            el.style.zIndex = '9998'; // In front of chat
            el.classList.add('rpg-weather-foreground');
        } else if (extensionSettings.weatherBackground) {
            el.style.zIndex = '1'; // Behind chat (default)
            el.classList.remove('rpg-weather-foreground');
        } else {
            // Both disabled - don't show weather
            return;
        }

        weatherContainer = el;
        document.body.appendChild(weatherContainer);
        const engine = getParticleEngine();
        engine.mount(weatherContainer);
        engine.setEffects(canvasEffects);
    }).catch(() => {
        // weather.css failed to load — skip this build rather than paint an
        // unstyled overlay; the next weather update retries the fetch.
    });
}

/** Monotonic token canceling superseded deferred weather builds. */
let _buildToken = 0;

let _visibilityHandlerBound = false;

/**
 * Pause continuous particle animations while the tab is hidden.
 *
 * Weather effects are built from dozens of DOM nodes (up to ~80 for a night
 * scene) each running an `infinite` CSS animation. Those keep the compositor
 * busy and hold GPU/host memory for as long as the page is open — pure waste
 * when the tab isn't even visible. Toggling a single body class lets CSS park
 * every particle's `animation-play-state` with zero visual cost while visible.
 */
function syncAnimationPlayState() {
    document.body.classList.toggle('dooms-anim-paused', document.hidden);
}

function bindVisibilityPauseOnce() {
    if (_visibilityHandlerBound) return;
    _visibilityHandlerBound = true;
    document.addEventListener('visibilitychange', syncAnimationPlayState);
    syncAnimationPlayState();
}

/**
 * Initialize weather effects
 */
export function initWeatherEffects() {
    bindVisibilityPauseOnce();
    updateWeatherEffect();
}

/**
 * Toggle dynamic weather effects
 */
export function toggleDynamicWeather(enabled) {
    if (enabled) {
        updateWeatherEffect();
    } else {
        removeWeatherEffect();
    }
}

/**
 * Clean up weather effects
 */
export function cleanupWeatherEffects() {
    removeWeatherEffect();
}
