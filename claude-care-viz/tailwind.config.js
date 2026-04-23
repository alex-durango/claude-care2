/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        "bg-deep": "var(--bg-deep)",
        fg: "var(--fg)",
        "fg-dim": "var(--fg-dim)",
        "fg-low": "var(--fg-low)",
        "fg-ghost": "var(--fg-ghost)",
        accent: "var(--accent)",
      },
      fontFamily: {
        mono: ["var(--font)", "ui-monospace", "monospace"],
      },
    },
  },
  plugins: [],
};
