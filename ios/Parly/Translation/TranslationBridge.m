#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(ParlyTranslation, NSObject)

RCT_EXTERN_METHOD(
  translate:(NSString *)text
  from:(NSString *)sourceLang
  to:(NSString *)targetLang
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

RCT_EXTERN_METHOD(
  isLanguagePairAvailable:(NSString *)sourceLang
  to:(NSString *)targetLang
  resolve:(RCTPromiseResolveBlock)resolve
  reject:(RCTPromiseRejectBlock)reject
)

@end
