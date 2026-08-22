/**
 * Was implicit (Expo's own default preset, no file here) until
 * `@expensify/react-native-live-markdown`'s live parser needed one —
 * that parser runs as a WORKLET (its own header: "executed on the UI
 * thread as the user types"), and `react-native-worklets/plugin` is what
 * transforms a function marked `'worklet'` into something that can
 * actually run there. Nothing else in this app needed the file to exist
 * at all; `babel-preset-expo` alone was always Expo's own implicit
 * default.
 */
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
