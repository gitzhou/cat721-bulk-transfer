// eslint-disable-next-line no-undef
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  transform: {
    '^.+.tsx?$': ['ts-jest', {}],
  },
  testMatch: ['**/test/**/*.test.ts'],
  collectCoverage: true,
  coverageReporters: ['text', 'html'],
  verbose: true,
};
