// react-native-audio-record and react-native-sherpa-onnx both ship their own
// TypeScript declarations — import directly from the packages.
//
// One of those declarations is wrong: react-native-audio-record types `on` as
// returning void, while it returns the NativeEventEmitter subscription. That is
// corrected where it is used, in services/audio/AudioCaptureService.ts, rather
// than here — an ambient `declare module` block in this file cannot override a
// declaration the package itself provides.

export {};
