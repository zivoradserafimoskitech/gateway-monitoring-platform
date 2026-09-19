// §8: there was no way to jump to a device without knowing which list it was
// in and paging through it. On a fleet of 500 gateways that is the difference
// between answering a phone call in five seconds and in two minutes.
//
// Everything it searches is already in the cache: the gateway, device and site
// lists are queried by the pages themselves and shared by the tRPC client, so
// this adds no round trip of its own and filters locally.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { BellRing, Gauge, Network, Radio, Search } from "lucide-react";

export function GlobalSearch() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  // Ctrl/Cmd-K is the shortcut every developer and most operators already try.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  // Only fetch while the palette is open: this component is mounted on every
  // page, and three fleet-wide lists per page load would be a real cost.
  const gateways = trpc.gateways.list.useQuery(undefined, { enabled: open });
  const meters = trpc.meters.list.useQuery(undefined, { enabled: open });
  const sites = trpc.sites.list.useQuery(undefined, { enabled: open });

  const go = (to: string) => {
    setOpen(false);
    navigate(to);
  };

  const results = useMemo(
    () => ({
      gateways: (gateways.data ?? []).slice(0, 50),
      meters: (meters.data ?? []).slice(0, 50),
      sites: (sites.data ?? []).slice(0, 50),
    }),
    [gateways.data, meters.data, sites.data],
  );

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="gap-2 text-muted-foreground"
        onClick={() => setOpen(true)}
        aria-label={t.search.label}
      >
        <Search className="h-4 w-4" />
        <span className="hidden lg:inline">{t.search.label}</span>
        <kbd className="hidden rounded border px-1 text-[10px] lg:inline">⌘K</kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title={t.search.label} description={t.search.hint}>
        <CommandInput placeholder={t.search.placeholder} />
        <CommandList>
          <CommandEmpty>{t.search.empty}</CommandEmpty>
          {results.gateways.length > 0 && (
            <CommandGroup heading={t.nav.gateways}>
              {results.gateways.map((g) => (
                // value carries the UID too, so searching by serial number
                // works — which is what a field engineer actually has.
                <CommandItem key={`g${g.id}`} value={`${g.name} ${g.uid}`} onSelect={() => go(`/gateways/${g.id}`)}>
                  <Radio className="mr-2 h-4 w-4" />
                  {g.name}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{g.uid}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results.meters.length > 0 && (
            <CommandGroup heading={t.nav.meters}>
              {results.meters.map((m) => (
                <CommandItem key={`m${m.id}`} value={`${m.name} ${m.model ?? ""}`} onSelect={() => go(`/meters/${m.id}`)}>
                  <Gauge className="mr-2 h-4 w-4" />
                  {m.name}
                  <span className="ml-2 text-xs text-muted-foreground">{m.model}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          {results.sites.length > 0 && (
            <CommandGroup heading={t.common.sites}>
              {results.sites.map((s) => (
                <CommandItem key={`s${s.id}`} value={s.name} onSelect={() => go(`/sites/${s.id}/diagram`)}>
                  <Network className="mr-2 h-4 w-4" />
                  {s.name}
                </CommandItem>
              ))}
            </CommandGroup>
          )}
          <CommandGroup heading={t.search.jumpTo}>
            <CommandItem value="alarms" onSelect={() => go("/alarms")}>
              <BellRing className="mr-2 h-4 w-4" />
              {t.nav.alarms}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
