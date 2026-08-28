export default [{
  files: ['src/**/*.js', 'tests/unit/**/*.js'],
  languageOptions: {
    ecmaVersion: 'latest', sourceType: 'module',
    globals: Object.fromEntries([
      'window','document','navigator','location','performance','requestAnimationFrame',
      'cancelAnimationFrame','setTimeout','clearTimeout','setInterval','clearInterval',
      'console','URL','URLSearchParams','Image','innerWidth','innerHeight','devicePixelRatio',
      'addEventListener','removeEventListener','localStorage','fetch','HTMLInputElement',
      'HTMLSelectElement','HTMLButtonElement','Event','CustomEvent','ResizeObserver'
    ].map(name => [name, 'readonly'])),
  },
  rules: { 'no-undef': 'error', 'no-unreachable': 'error', 'no-constant-condition': 'error', 'no-debugger': 'error' },
}];
