module.exports = {
  preset: 'react-native',
  moduleNameMapper: {
    '^@dr\\.pogodin/react-native-fs$': '<rootDir>/__mocks__/react-native-fs.js',
  },
  // Without this whitelist, anything importing @react-navigation dies on
  // untranspiled ESM ("Unexpected token 'export'") — which is how the only
  // test that mounts the real component tree spent its life unable to run.
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|@react-navigation|react-native-.*|@dr\\.pogodin)/)',
  ],
  // react-native-worklets ships this resolver so its JS implementations load
  // under Jest instead of the .native ones (which throw without the bridge).
  resolver: 'react-native-worklets/jest/resolver.js',
  setupFiles: ['<rootDir>/jest.setup.js'],
};
