#import "PathwayMarkdownTextRun.h"
#import "PathwayMarkdownText.h"
#import "PathwayMarkdownTextRunComponentDescriptor.h"
#import <react/renderer/components/PathwayMarkdownTextSpec/EventEmitters.h>
#import <react/renderer/components/PathwayMarkdownTextSpec/Props.h>
#import <react/renderer/components/PathwayMarkdownTextSpec/RCTComponentViewHelpers.h>
#import "RCTFabricComponentsPlugins.h"
#import "Utils.h"

using namespace facebook::react;

@interface PathwayMarkdownTextRun () <RCTPathwayMarkdownTextRunViewProtocol>

@end

@implementation PathwayMarkdownTextRun {
  NSString * _text;
  RCTBubblingEventBlock _onPress;
  RCTBubblingEventBlock _onLongPress;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider
{
    return concreteComponentDescriptorProvider<PathwayMarkdownTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps = std::make_shared<const PathwayMarkdownTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props oldProps:(Props::Shared const &)oldProps
{
  const auto &oldViewProps = *std::static_pointer_cast<PathwayMarkdownTextRunProps const>(_props);
  const auto &newViewProps = *std::static_pointer_cast<PathwayMarkdownTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

- (void)onPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::PathwayMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onPress(facebook::react::PathwayMarkdownTextRunEventEmitter::OnPress{});
  }
}

- (void)onLongPress {
  if (_eventEmitter != nullptr) {
    std::dynamic_pointer_cast<const facebook::react::PathwayMarkdownTextRunEventEmitter>(_eventEmitter)
    ->onLongPress(facebook::react::PathwayMarkdownTextRunEventEmitter::OnLongPress{});
  }
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> PathwayMarkdownTextRunCls(void)
{
    return PathwayMarkdownTextRun.class;
}

@end
