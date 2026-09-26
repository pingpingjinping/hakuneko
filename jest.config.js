module.exports = {
    testEnvironment: 'node',
    testMatch: [
        '<rootDir>/src/**/__tests__/**/*.test.js',
        '<rootDir>/src/**/__tests__/**/*.tests.js'
    ],
    reporters: ['default', 'jest-junit']
};
