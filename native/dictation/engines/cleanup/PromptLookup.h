#pragma once
#include <algorithm>
#include <cstddef>
#include <vector>

// A matching three-token suffix suggests an unchanged passage in this request.
// These are proposals only: the model and grammar must accept each token.
template <typename Token>
std::vector<Token> lookupDictationDraft(const std::vector<Token> &source,
                                      const std::vector<Token> &output, int limit) {
    constexpr std::size_t matchSize = 3;
    if (limit <= 0 || output.size() < matchSize || source.size() <= matchSize) return {};
    const auto suffix = output.end() - matchSize;
    for (std::size_t end = source.size() - 1; end >= matchSize; --end) {
        if (std::equal(suffix, output.end(), source.begin() + end - matchSize)) {
            const auto count = std::min(static_cast<std::size_t>(limit), source.size() - end);
            return {source.begin() + end, source.begin() + end + count};
        }
    }
    return {};
}
