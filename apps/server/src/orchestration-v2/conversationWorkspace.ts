import type { ProviderAdapterV2TurnInput } from "./ProviderAdapter.ts";

/** Keep the original conversation workspace explicit when a project is attached. */
export function withConversationWorkspace(
  input: ProviderAdapterV2TurnInput,
): ProviderAdapterV2TurnInput {
  const conversationPath = input.appThread.conversationPath;
  if (conversationPath == null || input.appThread.projectId === null) return input;
  const workspace = input.runtimePolicy.cwd;
  const context = [
    "[Pathway workspace context]",
    `This conversation's original folder is ${JSON.stringify(conversationPath)}. Its existing files remain there.`,
    ...(workspace === null
      ? []
      : [`The attached project workspace is ${JSON.stringify(workspace)}.`]),
    "You can access and use both directories. Preserve the conversation's existing files unless the user asks to move or remove them.",
    "[/Pathway workspace context]",
  ].join("\n");
  return { ...input, message: { ...input.message, text: `${context}\n\n${input.message.text}` } };
}
