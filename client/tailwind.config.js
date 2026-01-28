export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        midnight: "#0b1120",
        neon: "#7df9ff",
        magenta: "#ff4fd8"
      },
      boxShadow: {
        glow: "0 0 30px rgba(125, 249, 255, 0.35)"
      }
    }
  },
  plugins: []
};
