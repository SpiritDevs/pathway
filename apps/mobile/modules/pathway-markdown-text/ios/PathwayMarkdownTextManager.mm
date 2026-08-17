#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import "RCTBridge.h"
#import "Utils.h"

@interface PathwayMarkdownTextManager : RCTViewManager
@end

@implementation PathwayMarkdownTextManager

RCT_EXPORT_MODULE(PathwayMarkdownText)

- (UIView *)view
{
  return [[UIView alloc] init];
}

RCT_CUSTOM_VIEW_PROPERTY(color, NSString, UIView)
{
}

@end

@interface PathwayMarkdownTextRunManager : RCTViewManager
@end

@implementation PathwayMarkdownTextRunManager

RCT_EXPORT_MODULE(PathwayMarkdownTextRun)

- (UIView *)view
{
  return nil;
}

@end
