import { memo, useState } from "react";
import { RightLine } from "@mingcute/react";
import { useTranslation } from "@/languages";
import { cn } from "@/shared/lib";
import Dialog from "@/shared/ui/Dialog";
import { DialogHeader } from "@/shared/ui/DialogActions";
import ToggleSwitch from "@/shared/ui/ToggleSwitch";
import type { Track } from "@/shared/types";
import { usePlayerState } from "@/features/player/hooks/usePlayerState";
import { useMixStore } from "@/features/player/store/mixStore";
import { useTrackAnalysisStore } from "@/features/player/store/trackAnalysisStore";
import {
  DEFAULT_TRANSITION,
  settingsForStyle,
  transitionKey,
  type TransitionSettings,
} from "@/features/player/engine/transitions";
import TransitionEditor from "./TransitionEditor";
import {
  STYLE_ORDER,
  lengthLabel,
  matchesPreset,
  shownStyleLabel,
  styleLabel,
} from "./mixLabels";

export interface MixDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  playlistId: string;
  tracks: Track[];
}

const TransitionRow = memo(function TransitionRow({
  index,
  from,
  to,
  settings,
  isOverride,
  onOpen,
}: {
  index: number;
  from: Track;
  to: Track;
  settings: TransitionSettings;
  isOverride: boolean;
  onOpen: (index: number) => void;
}) {
  const { t } = useTranslation();
  const fromBpm = useTrackAnalysisStore(
    (state) => state.byTrack[from.id]?.bpm ?? null,
  );
  const label =
    settings.style === "cut"
      ? shownStyleLabel(t, settings)
      : `${shownStyleLabel(t, settings)} · ${lengthLabel(t, settings, fromBpm)}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(index)}
      className="flex w-full cursor-pointer items-center gap-[10px] rounded-item border-0 bg-transparent px-[10px] py-[8px] text-left transition-colors hover:bg-fill-hover"
    >
      <span className="w-[22px] shrink-0 text-right text-caption tabular-nums text-text-tertiary">
        {index + 1}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label font-[500] text-text-primary">
          {from.title}
        </span>
        <span className="truncate text-body text-text-tertiary">
          → {to.title}
        </span>
      </span>
      <span
        className={cn(
          "shrink-0 rounded-control px-[8px] py-[3px] text-caption font-[600]",
          isOverride
            ? "bg-fill-strong text-text-primary"
            : "bg-fill text-text-tertiary",
        )}
      >
        {label}
      </span>
      <RightLine size={16} className="shrink-0 text-text-tertiary" />
    </button>
  );
});

export default function MixDialog({
  open,
  onOpenChange,
  playlistId,
  tracks,
}: MixDialogProps) {
  const { t } = useTranslation();
  const mix = useMixStore((state) => state.mixes[playlistId]);
  const setEnabled = useMixStore((state) => state.setEnabled);
  const setDefaultTransition = useMixStore(
    (state) => state.setDefaultTransition,
  );
  const shuffle = usePlayerState().shuffle;
  const [editing, setEditing] = useState<number | null>(null);

  const enabled = mix?.enabled ?? false;
  const defaultTransition = mix?.defaultTransition ?? DEFAULT_TRANSITION;
  const pairs = tracks.length > 1 ? tracks.length - 1 : 0;
  const editingPair =
    editing !== null && editing < pairs
      ? { from: tracks[editing], to: tracks[editing + 1] }
      : null;

  const close = (next: boolean) => {
    if (!next) setEditing(null);
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      maxWidth={600}
      className="pt-[20px] pb-[16px]"
    >
      <div className="flex min-h-0 flex-col gap-[16px] overflow-y-auto px-[20px]">
        {editingPair ? (
          <TransitionEditor
            key={`${editingPair.from.id}>${editingPair.to.id}`}
            playlistId={playlistId}
            from={editingPair.from}
            to={editingPair.to}
            onBack={() => setEditing(null)}
          />
        ) : (
          <>
            <DialogHeader
              title={t("mix.title")}
              description={t("mix.description")}
            />
            <div className="flex items-center justify-between gap-[12px] rounded-item bg-fill px-[14px] py-[12px]">
              <div className="flex min-w-0 flex-col">
                <span className="text-label font-[500] text-text-primary">
                  {t("mix.enable")}
                </span>
                <span className="text-body text-text-tertiary">
                  {t("mix.enable_hint")}
                </span>
              </div>
              <ToggleSwitch
                checked={enabled}
                ariaLabel={t("mix.enable")}
                onChange={(next) => setEnabled(playlistId, next)}
              />
            </div>

            <div
              className={cn(
                "flex flex-col gap-[16px] transition-opacity duration-200",
                !enabled && "pointer-events-none opacity-40",
              )}
              aria-disabled={!enabled}
            >
              <section className="flex flex-col gap-[8px]">
                <span className="text-body font-[600] text-text-secondary">
                  {t("mix.every_transition")}
                </span>
                <div className="flex flex-wrap gap-[6px]">
                  {STYLE_ORDER.map((style) => {
                    const active =
                      defaultTransition.style === style &&
                      matchesPreset(defaultTransition);
                    return (
                      <button
                        key={style}
                        type="button"
                        onClick={() =>
                          setDefaultTransition(
                            playlistId,
                            settingsForStyle(style, defaultTransition.seconds),
                          )
                        }
                        className={cn(
                          "h-[30px] cursor-pointer rounded-control border-0 px-[12px] text-body font-[500] transition-colors",
                          active
                            ? "bg-text-primary text-bg-primary"
                            : "bg-fill text-text-primary hover:bg-fill-hover",
                        )}
                      >
                        {styleLabel(t, style)}
                      </button>
                    );
                  })}
                </div>
                <span className="text-caption text-text-tertiary">
                  {defaultTransition.style === "auto"
                    ? t("mix.auto_hint")
                    : shuffle
                      ? t("mix.shuffle_note")
                      : null}
                </span>
              </section>

              <section className="flex flex-col gap-[4px]">
                <span className="text-body font-[600] text-text-secondary">
                  {t("mix.transitions")}
                </span>
                {pairs === 0 ? (
                  <span className="py-[10px] text-body text-text-tertiary">
                    {t("mix.empty")}
                  </span>
                ) : (
                  <div className="-mx-[10px] flex flex-col">
                    {tracks.slice(0, pairs).map((from, index) => {
                      const to = tracks[index + 1];
                      const override =
                        mix?.transitions[transitionKey(from.id, to.id)];
                      return (
                        <TransitionRow
                          key={`${from.id}>${to.id}:${index}`}
                          index={index}
                          from={from}
                          to={to}
                          settings={override ?? defaultTransition}
                          isOverride={Boolean(override)}
                          onOpen={setEditing}
                        />
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
