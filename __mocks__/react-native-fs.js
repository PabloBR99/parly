// Jest stub for @dr.pogodin/react-native-fs.
//
// The library can't load under the Jest jsdom-less RN preset because it
// reaches into the native bridge. We only need the disk persistence layer at
// runtime; tests don't care, so return inert defaults.

module.exports = {
  DocumentDirectoryPath: '/mock-docs',
  exists: () => Promise.resolve(false),
  readFile: () => Promise.resolve(''),
  writeFile: () => Promise.resolve(),
  appendFile: () => Promise.resolve(),
  unlink: () => Promise.resolve(),
  mkdir: () => Promise.resolve(),
};
