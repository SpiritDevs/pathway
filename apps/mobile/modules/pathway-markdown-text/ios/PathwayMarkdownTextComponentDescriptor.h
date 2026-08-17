#pragma once

#include "PathwayMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using PathwayMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<PathwayMarkdownTextShadowNode>;

void PathwayMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
