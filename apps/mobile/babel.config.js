/**
 * Was implicit (Expo's own default preset, no file here) until
 * `@expensify/react-native-live-markdown`'s live parser needed one —
 * that parser runs as a WORKLET (its own header: "executed on the UI
 * thread as the user types"), and `react-native-worklets/plugin` is what
 * transforms a function marked `'worklet'` into something that can
 * actually run there. Nothing else in this app needed the file to exist
 * at all; `babel-preset-expo` alone was always Expo's own implicit
 * default.
 *
 * `babel-preset-expo` is a real `package.json` dependency, not just a
 * string here, for the same reason as everything else in this file: once
 * this preset list names it, `@babel/core` resolves it with a plain
 * `require.resolve` from this package's own directory — Expo's implicit
 * default has its own internal resolution path that tolerates it being
 * merely a transitive dependency of `expo`, but an EXPLICIT preset entry
 * does not, and EAS's release bundle step (`createBundleReleaseJsAndAssets`,
 * a different code path from a plain `expo export`) is where that gap
 * surfaced: `Cannot find module 'babel-preset-expo'`.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
