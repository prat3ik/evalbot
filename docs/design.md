# EvalBot — Design System

EvalBot's UI follows **Claude's design language**: warm, paper-like, calm, with a single high-contrast accent. The feel is "well-made document" rather than "SaaS dashboard". Generous whitespace, soft borders, restrained motion, no gradients-as-decoration.

---

## Design Principles

1. **Paper, not screen** — warm off-white surfaces, never pure `#FFFFFF`.
2. **One accent, used sparingly** — Claude's burnt-orange highlights the *single* most important action or value on a view.
3. **Numbers are first-class** — scores, percentages, and metrics are large, readable, and visually anchored.
4. **Serif for prose, sans for UI** — long-form rationale text uses the serif; labels, tables, and controls use the sans.
5. **Quiet motion** — fades and 150–200 ms transitions only. No bouncing, no parallax.
6. **Borders over shadows** — 1px hairline borders on warm surfaces. Shadows are reserved for elevated overlays (modals, popovers).

---

## Color Tokens

All values are sRGB. Names follow `--ev-<role>-<variant>`. Light theme is canonical; dark theme is a stretch goal.

### Surfaces & text (warm neutrals)

| Token                   | Light            | Role |
|-------------------------|------------------|------|
| `--ev-bg`               | `#FAF9F5`        | App background (warm paper) |
| `--ev-surface`          | `#F5F4EE`        | Card / panel background |
| `--ev-surface-raised`   | `#FFFFFF`        | Modal, popover, dropdown |
| `--ev-surface-sunken`   | `#EFEDE4`        | Code blocks, input wells |
| `--ev-border`           | `#E5E2D6`        | Hairline divider |
| `--ev-border-strong`    | `#CFCBBC`        | Input border, focused divider |
| `--ev-text`             | `#1F1E1B`        | Primary text |
| `--ev-text-muted`       | `#6B6A63`        | Secondary text, captions |
| `--ev-text-subtle`      | `#9A9890`        | Placeholder, disabled |

### Accent (Claude burnt-orange)

| Token                   | Value     | Role |
|-------------------------|-----------|------|
| `--ev-accent`           | `#D97757` | Primary action, key highlight |
| `--ev-accent-hover`     | `#C96846` | Hover on accent |
| `--ev-accent-pressed`   | `#B85A3B` | Active state |
| `--ev-accent-soft`      | `#F4E1D6` | Accent-tinted background (chips, selected rows) |
| `--ev-accent-fg`        | `#FFFFFF` | Text/icon on accent |

### Semantic (score bands & states)

Mapped to the score tiles in the Evaluate view (red <60, amber 60–80, green ≥80).

| Token                   | Value     | Role |
|-------------------------|-----------|------|
| `--ev-success`          | `#5A8F5C` | Pass, score ≥ 80 |
| `--ev-success-soft`     | `#E4EEDE` | Pass background |
| `--ev-warn`             | `#C08A2E` | Caution, score 60–79 |
| `--ev-warn-soft`        | `#F4E9CC` | Warn background |
| `--ev-danger`           | `#B5523F` | Fail, score < 60, critical rule violation |
| `--ev-danger-soft`      | `#F1D9D1` | Fail background |
| `--ev-info`             | `#3D6A8C` | Informational chips |
| `--ev-info-soft`        | `#DDE6EE` | Info background |

### Chart palette (categorical, ordered)

Tuned to harmonize with the warm background — no neon.

1. `#D97757` — accent / primary series (e.g. AI score)
2. `#3D6A8C` — secondary series (e.g. ML/NLP score)
3. `#7A6FAE` — tertiary (e.g. Combined)
4. `#5A8F5C` — quaternary
5. `#C08A2E` — quinary
6. `#8C6E5A` — neutral series

---

## Typography

### Font families

```css
--ev-font-serif: "Copernicus", "Tiempos Text", "Source Serif Pro", "Charter", Georgia, serif;
--ev-font-sans:  "Styrene B", "Inter", "Söhne", system-ui, -apple-system, "Segoe UI", sans-serif;
--ev-font-mono:  "JetBrains Mono", "IBM Plex Mono", "SF Mono", Menlo, monospace;
```

Use **serif** for: page titles, rationale / explanation prose, empty-state copy.
Use **sans** for: nav, labels, buttons, table cells, badges, form controls.
Use **mono** for: scores in detail tables, code/JSON, rule schema editor, IDs.

### Scale

| Token              | Size / line-height | Weight | Family | Use |
|--------------------|--------------------|--------|--------|-----|
| `--ev-display`     | 56 / 60            | 500    | serif  | Score tiles ("90.2") |
| `--ev-h1`          | 32 / 40            | 500    | serif  | Page title |
| `--ev-h2`          | 22 / 30            | 500    | serif  | Section heading |
| `--ev-h3`          | 17 / 24            | 600    | sans   | Card title |
| `--ev-body`        | 15 / 22            | 400    | sans   | Default UI text |
| `--ev-body-serif`  | 16 / 26            | 400    | serif  | Rationale prose |
| `--ev-small`       | 13 / 18            | 500    | sans   | Labels, captions, table headers (uppercase tracking +0.04em) |
| `--ev-micro`       | 11 / 14            | 600    | sans   | Badge text, eyebrow labels |
| `--ev-mono-num`    | 14 / 20            | 500    | mono   | Sub-metric numbers (tnum, zero-width) |

Always enable: `font-feature-settings: "ss01", "cv11", "tnum";` for tabular numbers in metric tables.

---

## Spacing & Layout

4-pt base grid.

```
--ev-space-1: 4px
--ev-space-2: 8px
--ev-space-3: 12px
--ev-space-4: 16px
--ev-space-5: 24px
--ev-space-6: 32px
--ev-space-7: 48px
--ev-space-8: 64px
```

- Page horizontal padding: `--ev-space-6` (mobile `--ev-space-4`)
- Card inner padding: `--ev-space-5`
- Gap between cards: `--ev-space-4`
- Form field vertical rhythm: `--ev-space-3`
- Max content width: **1200px** for dashboards, **880px** for prose-heavy pages

---

## Radii, Borders, Elevation

```
--ev-radius-sm:  6px      /* chips, badges */
--ev-radius-md:  10px     /* buttons, inputs */
--ev-radius-lg:  14px     /* cards, panels */
--ev-radius-xl:  20px     /* score tiles, modals */
--ev-radius-full: 9999px  /* avatars, pill buttons */

--ev-border-width: 1px
--ev-focus-ring:   0 0 0 3px rgba(217, 119, 87, 0.35)  /* accent @ 35% */
```

Elevation (sparingly — only for things that float):

```
--ev-elev-1: 0 1px 2px rgba(31, 30, 27, 0.04), 0 1px 1px rgba(31, 30, 27, 0.03);
--ev-elev-2: 0 4px 12px rgba(31, 30, 27, 0.06), 0 2px 4px rgba(31, 30, 27, 0.04);
--ev-elev-3: 0 12px 32px rgba(31, 30, 27, 0.10), 0 4px 8px rgba(31, 30, 27, 0.06);
```

---

## Motion

```
--ev-ease:       cubic-bezier(0.2, 0, 0, 1);
--ev-ease-out:   cubic-bezier(0.16, 1, 0.3, 1);
--ev-dur-fast:   120ms
--ev-dur-base:   180ms
--ev-dur-slow:   320ms
```

- Hover/press: `--ev-dur-fast`
- Panel and modal entrances: `--ev-dur-base`
- Number count-up on score tiles: `--ev-dur-slow` with `--ev-ease-out` (one-shot, no loops)
- Reduce-motion: respect `prefers-reduced-motion` and disable count-ups + dialog slide-ins.

---

## Iconography

- **Lucide** icon set, stroke 1.5, size **18px** inline / **20px** in nav / **24px** in empty states.
- Icons inherit `currentColor`. No filled/duotone mixing within the same view.

---

## Component Tokens

### Buttons
| Variant   | BG                  | Text             | Border             | Hover BG               |
|-----------|---------------------|------------------|--------------------|------------------------|
| Primary   | `--ev-accent`       | `--ev-accent-fg` | none               | `--ev-accent-hover`    |
| Secondary | `--ev-surface`      | `--ev-text`      | `--ev-border-strong` | `--ev-surface-sunken` |
| Ghost     | transparent         | `--ev-text`      | none               | `--ev-surface`         |
| Danger    | transparent         | `--ev-danger`    | `--ev-danger`      | `--ev-danger-soft`     |

Sizes: `sm` 28px, `md` 36px, `lg` 44px height. Padding `0 14px` / `0 16px` / `0 20px`.

### Inputs
- Background `--ev-surface-raised`, border `--ev-border-strong`, radius `--ev-radius-md`.
- Focus: border `--ev-accent`, ring `--ev-focus-ring`.
- Textarea (chatbot response, rule schema): mono font, line-height 22, min-height 160px.

### Score Tile
- Surface `--ev-surface-raised`, border `--ev-border`, radius `--ev-radius-xl`, padding `--ev-space-6`.
- Number uses `--ev-display`, color shifts by band (`success` / `warn` / `danger`).
- Tiny label above number uses `--ev-micro` uppercase muted text.
- Bottom-edge color rail (4px) of the band color is optional emphasis on the "primary" score.

### Metric Bar
- Track: `--ev-surface-sunken`, 8px high, full radius.
- Fill: band color matching the percentage.
- Label + value on the same row, label sans, value mono with `tnum`.

### Cards / Panels
- `--ev-surface`, border `--ev-border`, radius `--ev-radius-lg`, padding `--ev-space-5`.
- Card title row: sans 17/24 weight 600, optional right-aligned action (ghost button).

### Sidebar Nav
- Width 232px, background `--ev-surface`, right border `--ev-border`.
- Item: 36px tall, radius `--ev-radius-md`, padded `--ev-space-3`.
- Active: background `--ev-accent-soft`, text `--ev-accent-pressed`, 2px accent bar on the leading edge.

### Badges / Chips
- Height 22px, radius `--ev-radius-sm`, padding `0 8px`, font `--ev-micro`.
- Semantic variants use the matching `*-soft` background + the strong color for text.

### Tables
- Header row: `--ev-small` uppercase, color `--ev-text-muted`, border-bottom `--ev-border`.
- Body row height 40px, border-bottom hairline, hover background `--ev-surface-sunken`.
- Numeric columns right-aligned, mono font with tabular numerals.

---

## Score Color Mapping

```ts
function scoreColor(score: number) {
  if (score >= 80) return { fg: "--ev-success", bg: "--ev-success-soft" };
  if (score >= 60) return { fg: "--ev-warn",    bg: "--ev-warn-soft" };
  return                  { fg: "--ev-danger",  bg: "--ev-danger-soft" };
}
```

Applied to: score-tile number color, metric-bar fill, pass/fail chips, Analytics tiles.

---

## Accessibility

- All text/background pairs meet **WCAG AA** (≥ 4.5:1 for body, ≥ 3:1 for large text and UI). The accent on accent-fg is verified for buttons.
- Focus ring is **always visible** (`:focus-visible`), never removed.
- Hit targets ≥ 32px on touch, ≥ 28px on pointer.
- Color is never the only signal: pass/fail also carries an icon and label.
- Honor `prefers-reduced-motion` and `prefers-color-scheme` (dark theme: stretch).

---

## CSS Variable Bundle (drop-in)

```css
:root {
  /* surfaces */
  --ev-bg: #FAF9F5;
  --ev-surface: #F5F4EE;
  --ev-surface-raised: #FFFFFF;
  --ev-surface-sunken: #EFEDE4;
  --ev-border: #E5E2D6;
  --ev-border-strong: #CFCBBC;
  /* text */
  --ev-text: #1F1E1B;
  --ev-text-muted: #6B6A63;
  --ev-text-subtle: #9A9890;
  /* accent */
  --ev-accent: #D97757;
  --ev-accent-hover: #C96846;
  --ev-accent-pressed: #B85A3B;
  --ev-accent-soft: #F4E1D6;
  --ev-accent-fg: #FFFFFF;
  /* semantic */
  --ev-success: #5A8F5C; --ev-success-soft: #E4EEDE;
  --ev-warn:    #C08A2E; --ev-warn-soft:    #F4E9CC;
  --ev-danger:  #B5523F; --ev-danger-soft:  #F1D9D1;
  --ev-info:    #3D6A8C; --ev-info-soft:    #DDE6EE;
  /* radius */
  --ev-radius-sm: 6px; --ev-radius-md: 10px;
  --ev-radius-lg: 14px; --ev-radius-xl: 20px;
  /* spacing */
  --ev-space-1: 4px;  --ev-space-2: 8px;  --ev-space-3: 12px; --ev-space-4: 16px;
  --ev-space-5: 24px; --ev-space-6: 32px; --ev-space-7: 48px; --ev-space-8: 64px;
  /* motion */
  --ev-ease: cubic-bezier(0.2, 0, 0, 1);
  --ev-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ev-dur-fast: 120ms; --ev-dur-base: 180ms; --ev-dur-slow: 320ms;
  /* focus */
  --ev-focus-ring: 0 0 0 3px rgba(217, 119, 87, 0.35);
}
```

---

## Tailwind Integration (sketch)

In `tailwind.config.ts`, map the tokens so utilities like `bg-surface`, `text-accent`, `rounded-lg`, `font-serif` come for free.

```ts
extend: {
  colors: {
    bg: "var(--ev-bg)",
    surface: { DEFAULT: "var(--ev-surface)", raised: "var(--ev-surface-raised)", sunken: "var(--ev-surface-sunken)" },
    border: { DEFAULT: "var(--ev-border)", strong: "var(--ev-border-strong)" },
    text:   { DEFAULT: "var(--ev-text)", muted: "var(--ev-text-muted)", subtle: "var(--ev-text-subtle)" },
    accent: { DEFAULT: "var(--ev-accent)", hover: "var(--ev-accent-hover)", pressed: "var(--ev-accent-pressed)", soft: "var(--ev-accent-soft)", fg: "var(--ev-accent-fg)" },
    success: { DEFAULT: "var(--ev-success)", soft: "var(--ev-success-soft)" },
    warn:    { DEFAULT: "var(--ev-warn)",    soft: "var(--ev-warn-soft)" },
    danger:  { DEFAULT: "var(--ev-danger)",  soft: "var(--ev-danger-soft)" },
    info:    { DEFAULT: "var(--ev-info)",    soft: "var(--ev-info-soft)" },
  },
  borderRadius: { sm: "var(--ev-radius-sm)", md: "var(--ev-radius-md)", lg: "var(--ev-radius-lg)", xl: "var(--ev-radius-xl)" },
  fontFamily: {
    serif: ["Copernicus", "Tiempos Text", "Source Serif Pro", "Charter", "Georgia", "serif"],
    sans:  ["Styrene B", "Inter", "Söhne", "system-ui", "sans-serif"],
    mono:  ["JetBrains Mono", "IBM Plex Mono", "SF Mono", "monospace"],
  },
}
```

---

## Do / Don't

**Do**
- Use the accent for one primary action per view ("Run Evaluation") and for the most important number when emphasizing.
- Let the warm paper background carry the calm — empty space is part of the design.
- Pair every score with a band color *and* a label.

**Don't**
- Don't use pure white as a page background.
- Don't apply gradients to score tiles or buttons.
- Don't introduce a second accent hue. Add categorical color from the chart palette instead.
- Don't rely on shadows where a 1px border would do.
