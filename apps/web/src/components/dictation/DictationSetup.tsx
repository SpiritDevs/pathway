import { useState } from "react";
import { ArrowRightIcon, CheckIcon, MicIcon } from "lucide-react";
import { Button } from "../ui/button";
import { type DictationActions } from "./DictationControls";
import { DictationSetupDialog } from "./DictationSetupDialog";

export function DictationSetup(props: DictationActions & { error?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <section className="rounded-2xl border border-border/70 bg-muted/20 p-6 sm:p-8">
        <div className="mb-5 flex size-11 items-center justify-center rounded-xl border border-border bg-background">
          <MicIcon className="size-5 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">Dictate into any app.</h1>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted-foreground">
          Turn your voice into text, with fillers and spoken corrections cleaned up. Recording and
          processing stay on this desktop.
        </p>
        <div className="mt-5 inline-flex items-center gap-2 text-xs text-muted-foreground">
          <CheckIcon className="size-3.5" />
          No audio saved in history
        </div>
        <div className="mt-7">
          <Button onClick={() => setOpen(true)}>
            Set Up Dictation
            <ArrowRightIcon className="size-4" />
          </Button>
        </div>
      </section>
      {open && <DictationSetupDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}
