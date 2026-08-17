#pragma once

#include <react/renderer/components/PathwayMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/PathwayMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char PathwayMarkdownTextComponentName[];

struct PathwayMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct PathwayMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
};

inline Float PathwayMarkdownTextAttachmentSize(const PathwayMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float PathwayMarkdownTextAttachmentBaselineOffset(
    const PathwayMarkdownTextAttachmentRange &) {
  return -2;
}

class PathwayMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<PathwayMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<PathwayMarkdownTextAttachmentRange> attachmentRanges;
};

class PathwayMarkdownTextShadowNode final : public ConcreteViewShadowNode<
PathwayMarkdownTextComponentName,
PathwayMarkdownTextProps,
PathwayMarkdownTextEventEmitter,
PathwayMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  PathwayMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<PathwayMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<PathwayMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
