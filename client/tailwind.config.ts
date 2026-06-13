import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--ev-bg)",
        surface: {
          DEFAULT: "var(--ev-surface)",
          raised: "var(--ev-surface-raised)",
          sunken: "var(--ev-surface-sunken)",
        },
        border: {
          DEFAULT: "var(--ev-border)",
          strong: "var(--ev-border-strong)",
        },
        text: {
          DEFAULT: "var(--ev-text)",
          muted: "var(--ev-text-muted)",
          subtle: "var(--ev-text-subtle)",
        },
        accent: {
          DEFAULT: "var(--ev-accent)",
          hover: "var(--ev-accent-hover)",
          pressed: "var(--ev-accent-pressed)",
          soft: "var(--ev-accent-soft)",
          fg: "var(--ev-accent-fg)",
        },
        success: {
          DEFAULT: "var(--ev-success)",
          soft: "var(--ev-success-soft)",
        },
        warn: {
          DEFAULT: "var(--ev-warn)",
          soft: "var(--ev-warn-soft)",
        },
        danger: {
          DEFAULT: "var(--ev-danger)",
          soft: "var(--ev-danger-soft)",
        },
        info: {
          DEFAULT: "var(--ev-info)",
          soft: "var(--ev-info-soft)",
        },
      },
      borderRadius: {
        sm: "var(--ev-radius-sm)",
        md: "var(--ev-radius-md)",
        lg: "var(--ev-radius-lg)",
        xl: "var(--ev-radius-xl)",
      },
      fontFamily: {
        serif: [
          "var(--font-serif)",
          "Copernicus",
          "Tiempos Text",
          "Source Serif Pro",
          "Charter",
          "Georgia",
          "serif",
        ],
        sans: ["var(--font-sans)", "Styrene B", "Inter", "Söhne", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "IBM Plex Mono", "SF Mono", "monospace"],
      },
      boxShadow: {
        "elev-1": "0 1px 2px rgba(31, 30, 27, 0.04), 0 1px 1px rgba(31, 30, 27, 0.03)",
        "elev-2": "0 4px 12px rgba(31, 30, 27, 0.06), 0 2px 4px rgba(31, 30, 27, 0.04)",
        "elev-3": "0 12px 32px rgba(31, 30, 27, 0.10), 0 4px 8px rgba(31, 30, 27, 0.06)",
        "focus-ring": "0 0 0 3px rgba(217, 119, 87, 0.35)",
      },
      transitionTimingFunction: {
        ev: "cubic-bezier(0.2, 0, 0, 1)",
        "ev-out": "cubic-bezier(0.16, 1, 0.3, 1)",
      },
      transitionDuration: {
        fast: "120ms",
        base: "180ms",
        slow: "320ms",
      },
    },
  },
  plugins: [],
};

export default config;
