// react-native-audio-record and react-native-sherpa-onnx ship their own
// TypeScript declarations — import directly from the packages. One of them is
// wrong (audio-record's `on` returns a subscription, not void); it is corrected
// at the use site in services/audio/AudioCaptureService.ts, because an ambient
// block here cannot override a declaration the package itself provides.

export {};
