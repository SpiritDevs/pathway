/** Present known checkout rejections while retaining the original diagnostic separately. */
export function describeBranchCheckoutError(message: string) {
  if (
    /Your local changes to the following files would be overwritten by checkout:/i.test(message)
  ) {
    return {
      title: "Local changes would be overwritten",
      description:
        "Commit or stash your changes before switching branches, or use a new worktree to keep this checkout intact.",
    };
  }
  if (/untracked working tree files would be overwritten by checkout:/i.test(message)) {
    return {
      title: "Untracked files would be overwritten",
      description:
        "Move or commit these files before switching branches, or use a new worktree to keep this checkout intact.",
    };
  }
  return {
    title: "Couldn’t switch branches",
    description: "Git couldn’t complete the checkout. See the details below for the reason.",
  };
}
