#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ParlyAudio, NSObject)

RCT_EXTERN_METHOD(
  configureSession:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  playPCM:(NSString *)base64Data
  sampleRate:(double)sampleRate
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

@end
