# Dialogue Color → Speaker Attribution

Tracking doc for the oldest bug in DES: **a newly-introduced character gets a
unique dialogue color, but their lines display under an existing character's
name (or "Unknown") instead of their own.**

Status: **fix ported from `test/auto-portraits`** (see "The fix" below).
Verify in-browser with the test script at the bottom before closing this out.

---

## How the pipeline works

Three systems each hold an opinion about "which color belongs to which
character", and the bug lives in the gaps between them:

1. **The prompt** (`injector.js` / `promptBuilder.js`) tells the AI to wrap
   dialogue in `<font color=#hex>` tags and lists the stored color
   assignments for known characters.
2. **The roster** (`characterColors` in settings / chat metadata) is DES's
   stored name → color mapping. The portrait bar auto-assigns a palette
   color to any roster character that doesn't have one.
3. **The bubble splitter** (`chatBubbles.js`) reverse-maps each font color
   back to a speaker name. Its Strategy 1 is the stored color map; when that
   misses, it falls back to guessing from surrounding narration text.

## The bug (pre-fix flow)

```mermaid
flowchart TD
    A["AI introduces NEW character Mira<br/>writes dialogue as<br/>&lt;font color=#74b9ff&gt;&quot;Hello&quot;&lt;/font&gt;<br/>(AI invented #74b9ff itself —<br/>Mira isn't in the assignments list)"] --> B["MESSAGE_RECEIVED<br/>parser stores tracker JSON<br/>Mira joins the roster — name only,<br/>no color information"]

    B --> C["Portrait bar render<br/>auto-assigns Mira the first UNUSED<br/>PALETTE color, e.g. #e94560"]

    C --> D{{"⚠️ TWO COLOR AUTHORITIES<br/>chat says Mira = #74b9ff<br/>roster says Mira = #e94560<br/>nothing ever reconciles them"}}

    D --> E["Chat bubbles run<br/>(CHARACTER_MESSAGE_RENDERED + 800ms)<br/>detectSpeaker(#74b9ff)"]

    E --> S1{"Strategy 1<br/>stored color map<br/>has #74b9ff?"}
    S1 -- "MISS — roster has Mira<br/>under #e94560 instead" --> S2{"Strategy 2<br/>color already resolved<br/>earlier this message?"}
    S2 -- MISS --> S3{"Strategies 3–5<br/>closest character name<br/>in nearby narration"}

    S3 -- "narration mentions an<br/>EXISTING character<br/>(e.g. 'Lyra watched as...')" --> W1["❌ Mira's lines attributed to LYRA<br/>wrong name on the bubble"]
    S3 -- "no known name nearby<br/>(Mira isn't in the name<br/>lookup heuristics can use)" --> S6{"Strategy 6<br/>exactly one character<br/>in scene?"}
    S6 -- no --> W2["❌ speaker = null<br/>bubble shows 'Unknown'"]

    style D fill:#7a2230,stroke:#e94560,color:#fff
    style W1 fill:#7a2230,stroke:#e94560,color:#fff
    style W2 fill:#7a2230,stroke:#e94560,color:#fff
```

Root causes, precisely:

| # | Cause | Where |
|---|---|---|
| 1 | The AI invents a color for a new speaker, but nothing records the (color → name) pair it just created | no harvest step existed |
| 2 | DES independently assigns the new character a *different* palette color, poisoning the stored map | `portraitBar.js` auto-assign |
| 3 | The narration-text fallback can only ever answer with an *already-known* name — for a brand-new speaker it is wrong by construction | `detectSpeaker` strategies 3–5 |

## The fix (ported flow)

Make the AI itself the single authority, captured at parse time — the same
turn that introduces the character delivers the mapping:

```mermaid
flowchart TD
    P["PROMPT (per generation)<br/>• characters tracker JSON now requires a<br/>&quot;color&quot; field matching the font hex used<br/>• stored assignments marked RESERVED —<br/>new characters must get a brand-new hex"] --> A["AI reply<br/>font-tagged dialogue +<br/>tracker JSON: {name: Mira, color: #74b9ff, ...}"]

    A --> H["harvestNewSpeakerColors()<br/>runs at parse time, BEFORE renderers<br/>(both Together mode and Separate/External mode)"]

    H --> H1{"entry has valid<br/>&quot;color&quot; field?"}
    H1 -- "yes (PRIMARY)" --> R["characterColors[Mira] = #74b9ff<br/>saved to roster — existing assignments<br/>are NEVER overwritten"]
    H1 -- "no (model dropped it)" --> H2["FALLBACK: pair unrecognized font<br/>colors in the message with colorless<br/>new characters, in order of appearance"]
    H2 --> R

    R --> PB["Portrait bar render (later, scheduled)<br/>Mira already has a color →<br/>palette auto-assign SKIPS her<br/>(palette is now last-resort only)"]

    R --> B["Bubble splitter<br/>detectSpeaker(#74b9ff)<br/>Strategy 1: color map HIT"]
    B --> OK["✅ bubble says MIRA<br/>same color in portraits, bubbles,<br/>and future prompts"]

    R --> N["Next generation's prompt lists<br/>Mira = #74b9ff as RESERVED<br/>loop is closed"]

    style OK fill:#1d4a2a,stroke:#2ecc71,color:#fff
    style H fill:#1a3a5c,stroke:#74b9ff,color:#fff
```

Plus one more repair on the lookup side: `buildColorToSpeakerMap` is now
built in two passes — absent-but-known characters first, **present characters
second** — so if the AI reuses an absent character's color for someone
on-screen, the present speaker wins the collision instead of the absent one.

### What was ported (from `test/auto-portraits`)

| Piece | File | Role |
|---|---|---|
| `"color"` field in characters tracker JSON (only when dialogue coloring is on) | `jsonPromptHelpers.js` | AI declares its own mapping |
| "never reuse a color / record the hex in the JSON" instruction | `promptBuilder.js` (`DEFAULT_DIALOGUE_COLORING_PROMPT`) | prevents collisions at the source |
| RESERVED-colors wording on the per-character assignment list | `injector.js` (`buildColorAssignments`) | protects existing assignments |
| `harvestNewSpeakerColors()` + `_extractCharacterEntries()` | `chatBubbles.js` | captures the mapping at parse time (primary: JSON field; fallback: positional pairing) |
| Harvest call after tracker parse — Together mode | `integration/sillytavern.js` | runs before bubbles/renderers |
| Harvest call after tracker parse — Separate/External mode | `generation/apiClient.js` | same guarantee for the second API call |
| Two-pass present-overrides-absent color map | `chatBubbles.js` (`buildColorToSpeakerMap`) | collision repair on lookup |

### What was deliberately kept

- The portrait bar's palette auto-assign stays, as a **last resort** for
  characters that somehow arrive with no color from any source. The harvest
  runs earlier in the pipeline, so in practice it wins the race; the palette
  only fills true gaps.
- `detectSpeaker`'s narration heuristics (strategies 3–5) stay as fallbacks
  for messages with no tracker data at all (old chats, suppressed tracker).

## Known residual risks

- **Small models may drop the `color` field** → fallback pairing is
  positional (first new color ↔ first colorless character) and can mispair
  when several characters debut in one turn with mismatched counts. The
  narration fallback then decides — same as pre-fix behavior, no worse.
- **The AI can still disobey** the never-reuse instruction; the two-pass map
  limits the damage (present speaker wins), but two *present* characters
  sharing a color is unrecoverable until the user fixes one in the Workshop.
- Existing chats whose rosters already contain palette-poisoned colors won't
  self-heal (assignments are never overwritten by design). Clearing a wrong
  color in the Workshop lets the next harvest re-learn it from the AI.

## In-browser verification script

1. Fresh chat with dialogue coloring + chat bubbles + portrait bar on.
2. Let the AI introduce a brand-new named character mid-conversation.
3. Check, in order:
   - System Log shows `Registered 1 new speaker color: <Name> → #...` —
     `(from JSON)` is the primary path, `(heuristic)` the fallback.
   - The new character's bubble shows **their own name**, not another
     character's, not "Unknown".
   - Portrait bar card color dot matches the dialogue color in chat.
   - Context Inspector → next generation's dialogue-coloring prompt lists
     the new character in the RESERVED assignments.
4. Introduce TWO new characters in one reply — both should attribute
   correctly via the JSON path.
5. Have an absent character's color get reused by the AI for someone present
   (hard to force; if observed, the present character must win the bubble).
