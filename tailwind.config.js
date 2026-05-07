/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Fraunces"', 'serif'],
        sans: ['"Inter Tight"', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      colors: {
        ink: '#0a0a0a',
        bone: '#f5f1ea',
        clay: '#d8cfc1',
        rust: '#c44536',
        moss: '#3d5240',
        amber: '#e0a458',
      },
    },
  },
  plugins: [],
};
