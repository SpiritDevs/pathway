#pragma once

#include <react/renderer/components/PathwayMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/PathwayMarkdownTextSpec/Props.h>
#include <react/renderer/components/PathwayMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char PathwayMarkdownTextRunComponentName[];

using PathwayMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    PathwayMarkdownTextRunComponentName,
    PathwayMarkdownTextRunProps,
    PathwayMarkdownTextRunEventEmitter,
    PathwayMarkdownTextRunState>;
}
