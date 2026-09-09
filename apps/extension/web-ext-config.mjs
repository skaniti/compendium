// web-ext build/sign would otherwise bundle tests/, package.json, and its own
// prior output into the extension artifact -- browsers ignore these files
// regardless, but keeping web-ext's own view of the source tree honest here
// avoids shipping dev-only files (and re-signing them) unnecessarily.
export default {
  ignoreFiles: ['tests/**', 'package.json', 'web-ext-config.mjs', 'web-ext-artifacts/**']
};
