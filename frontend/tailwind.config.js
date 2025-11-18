module.exports = {
  content: [
    "./src/**/*.{js,jsx,ts,tsx}",
    "./index.html"
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        glass: {
          light: 'rgba(255,255,255,0.55)',
          dark: 'rgba(30,41,59,0.55)'
        }
      },
      keyframes: {
        fadeInLeft: {
          '0%': { opacity: '0', transform: 'translateX(-16px)' },
          '100%': { opacity: '1', transform: 'translateX(0)' }
        },
        typeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' }
        },
        cardEnter: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' }
        },
        shimmer: {
          '0%': { backgroundPosition: '-200% 0' },
          '100%': { backgroundPosition: '200% 0' }
        }
      },
      animation: {
        'fade-in-left': 'fadeInLeft 600ms ease-out both',
        'type-in': 'typeIn 600ms ease-out both',
        'card-enter': 'cardEnter 600ms ease-out both',
        shimmer: 'shimmer 1.8s linear infinite'
      }
    }
  },
  plugins: []
}

