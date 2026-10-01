import type { DeviceSummary, EnvironmentId } from "@spiritdevs/contracts";
import { useState } from "react";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { deviceEnvironment } from "~/state/device";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { companionPhones, watchPairLabel } from "./deviceFamily";

/**
 * Pair a Watch with an explicit same-host iPhone, or unpair it. The server
 * republishes device state after either change, so the label follows it.
 */
export function DeviceWatchPairing(props: {
  readonly environmentId: EnvironmentId;
  readonly watch: DeviceSummary;
  readonly devices: ReadonlyArray<DeviceSummary>;
  readonly disabled?: boolean;
}) {
  const { watch } = props;
  const runAction = useAtomCommand(deviceEnvironment.action, { reportFailure: false });
  const [phoneId, setPhoneId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = watchPairLabel(watch, props.devices);
  if (label === undefined) {
    return (
      <p className="text-xs text-muted-foreground">
        Pairing needs a newer Pathway server on this environment.
      </p>
    );
  }
  const phones = companionPhones(watch, props.devices);
  const selected = phones.find((phone) => phone.id === phoneId) ?? phones[0] ?? null;
  const disabled = pending || props.disabled === true;
  const run = (body: { type: "pairWatch"; phoneDeviceId: string } | { type: "unpairWatch" }) => {
    setPending(true);
    setError(null);
    void runAction({
      environmentId: props.environmentId,
      input: { hostId: watch.hostId, deviceId: watch.id, ...body },
    })
      .then((result) => {
        if (result._tag === "Failure") setError(formatEnvironmentQueryError(result.cause));
      })
      .finally(() => setPending(false));
  };
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex min-h-7 flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {label}
          {watch.watchPair && watch.watchPair.state !== "(active, connected)"
            ? ` · ${watch.watchPair.state}`
            : ""}
        </span>
        {pending ? <Spinner className="size-3" /> : null}
        {watch.watchPair ? (
          <Button
            size="xs"
            variant="outline"
            disabled={disabled}
            aria-label={`Unpair ${watch.name}`}
            onClick={() => run({ type: "unpairWatch" })}
          >
            Unpair
          </Button>
        ) : phones.length === 0 ? (
          <span className="text-muted-foreground">No iPhone simulators on this host.</span>
        ) : (
          <>
            <Select
              value={selected?.id ?? null}
              disabled={disabled}
              onValueChange={(value) => setPhoneId(value)}
            >
              <SelectTrigger
                size="xs"
                className="w-40"
                aria-label={`iPhone to pair with ${watch.name}`}
              >
                <SelectValue>{selected?.name}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {phones.map((phone) => (
                  <SelectItem key={phone.id} value={phone.id}>
                    {phone.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || !selected}
              aria-label={`Pair ${watch.name} with ${selected?.name ?? "iPhone"}`}
              onClick={() => selected && run({ type: "pairWatch", phoneDeviceId: selected.id })}
            >
              Pair
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="whitespace-pre-wrap break-words text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
