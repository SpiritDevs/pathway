#include "../cleanup/PromptLookup.h"
#include <cstdlib>
#include <iostream>

using Tokens = std::vector<int>;

void check(const Tokens &source, const Tokens &output, int limit, const Tokens &expected) {
    if (lookupDictationDraft(source, output, limit) != expected) {
        std::cerr << "Unexpected dictation draft\n";
        std::exit(1);
    }
}

int main() {
    check({}, {}, 8, {});
    check({1, 2, 3, 4}, {1, 2}, 8, {});
    check({1, 2, 3}, {1, 2, 3}, 8, {});
    check({1, 2, 3, 4}, {8, 2, 3}, 8, {});
    check({1, 2, 3, 4}, {1, 2, 3}, 0, {});
    check({1, 2, 3, 4}, {1, 2, 3}, -1, {});
    check({1, 2, 3, 4}, {9, 1, 2, 3}, 8, {4});
    check({1, 2, 3, 4, 5, 6}, {1, 2, 3}, 2, {4, 5});
    check({1, 2, 3, 4, 5, 6}, {1, 2, 3}, 8, {4, 5, 6});
    check({1, 2, 3, 4, 5, 6}, {4, 5, 6}, 8, {});
    // Repeated phrases choose the most recent continuation; the model verifies it.
    check({1, 2, 3, 4, 1, 2, 3, 9}, {1, 2, 3}, 8, {9});
    // A changed word must break the match until three accepted tokens align again.
    check({1, 2, 3, 4, 5, 6, 7}, {1, 2, 9}, 8, {});
    check({1, 2, 3, 4, 5, 6, 7}, {1, 2, 9, 4, 5, 6}, 8, {7});
    // Each lookup sees only the current request's source.
    check({9, 8, 7, 6}, {1, 2, 3}, 8, {});
    std::cout << "14 dictation prompt-lookup checks passed\n";
}
