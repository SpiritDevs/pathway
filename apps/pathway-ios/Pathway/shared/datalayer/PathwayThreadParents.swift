import Foundation

/// Parent and child links between threads, which may span environments.
enum PathwayThreadParents {
    /// The thread's parent and the unarchived threads listed under it, newest first.
    static func lineage(
        of thread: PathwayAgentThread,
        in threads: [PathwayAgentThread]
    ) -> (parent: PathwayAgentThread?, children: [PathwayAgentThread]) {
        let parent = thread.parentKey.flatMap { key in threads.first { $0.lineageKey == key } }
        let children = threads
            .filter { $0.parentKey == thread.lineageKey && $0.shell.archivedAt == nil }
            .sorted { $0.sortDate > $1.sortDate }
        return (parent, children)
    }

    /// Threads `thread` can be listed under: not archived, not itself, and not anything already
    /// listed beneath it, which would make a loop.
    static func candidates(
        for thread: PathwayAgentThread,
        in threads: [PathwayAgentThread]
    ) -> [PathwayAgentThread] {
        var childrenByParent: [String: [String]] = [:]
        for candidate in threads {
            guard let parentKey = candidate.parentKey else { continue }
            childrenByParent[parentKey, default: []].append(candidate.lineageKey)
        }
        var excluded: Set<String> = [thread.lineageKey]
        var pending = [thread.lineageKey]
        while let next = pending.popLast() {
            for child in childrenByParent[next] ?? [] where excluded.insert(child).inserted {
                pending.append(child)
            }
        }
        return threads
            .filter { $0.shell.archivedAt == nil && !excluded.contains($0.lineageKey) }
            .sorted { $0.sortDate > $1.sortDate }
    }
}
