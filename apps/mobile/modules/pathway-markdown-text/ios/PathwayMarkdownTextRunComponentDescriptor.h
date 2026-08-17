#pragma once

#include "PathwayMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using PathwayMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<PathwayMarkdownTextRunShadowNode>;

void PathwayMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
