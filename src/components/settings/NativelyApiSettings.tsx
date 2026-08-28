import {
  AlertCircle,
  Brain,
  Check,
  CheckCircle,
  Layers,
  Loader2,
  Mic,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n';
import { motion, AnimatePresence, LayoutGroup, useReducedMotion } from 'framer-motion';
import { AccordionSection, Disclosure } from '../ui/AccordionSection';
import { InteractiveCard } from '../ui/InteractiveCard';

import { getMeetingInterfaceTheme, type MeetingInterfaceTheme } from '../../lib/meetingInterfaceTheme';
import { BEAT, EASE_ENTER, EASE_LEAVE, INK, SETTLE } from '../../lib/plansMotion';
// Painted as a CSS mask, not rendered as an <img>: the asset is a white
// monochrome glyph, so on the light theme's pale plaque an <img> would be
// invisible. See `.natively-key-mark` in index.css.
import nativelyLogo from '../../assets/logo.webp';

// ─── Types ───────────────────────────────────────────────────
interface QuotaBucket {
  used: number;
  limit: number;
  remaining: number;
}
interface UsageData {
  plan: string;
  member_since: string;
  quota: {
    transcription: QuotaBucket;
    ai: QuotaBucket;
    search: QuotaBucket;
    resets_at: string;
  };
}

const MASKED_NATIVELY_KEY = '•'.repeat(24);

// Last-known usage cache so the usage panel can paint immediately on revisit.
const USAGE_STORAGE_KEY = 'natively_api_usage_v1';

function readUsageCache(): UsageData | null {
  try {
    const raw = localStorage.getItem(USAGE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Shape-check before trusting: a partial write would otherwise throw inside
    // the render path when QuotaBar reads `.used`/`.limit`.
    if (!parsed?.quota?.transcription || !parsed.quota.ai || !parsed.quota.search) return null;
    const resets = Date.parse(parsed.quota.resets_at);
    if (Number.isFinite(resets) && resets < Date.now()) return null;
    return parsed as UsageData;
  } catch {
    return null;
  }
}

let usageCache: UsageData | null = readUsageCache();

function setUsageCache(next: UsageData | null): void {
  usageCache = next;
  try {
    if (next) localStorage.setItem(USAGE_STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(USAGE_STORAGE_KEY);
  } catch {
    // Storage unavailable or full — in-memory caching still works for this
    // session, only the cross-restart benefit is lost.
  }
}

// Picks a glyph for a feature row from the feature's OWN wording. The
// references all use characterful, varied icons rather than one repeated
// tick, and a per-row icon is what stops a feature list reading as a generic
// bulleted list. This is presentation only — it classifies the existing
// PLANS[].features strings and asserts nothing they do not already say.
function pickFeatureIcon(feature: string) {
    const f = feature.toLowerCase();
    if (f.includes('transcription') || f.includes('recording')) return Mic;
    if (f.includes('search')) return Search;
    if (f.includes('pro app')) return Layers;
    return Sparkles; // the AI-usage rows
}

// cardSlideLeftVariants / cardSlideRightVariants / cardCtaVariants were removed
// here: the redesign replaced the two-column body (which carried them on the
// left column, the features panel and the CTA block) with a mesh header +
// single body, so nothing consumed them any more. Only the container-level
// opacity crossfade between tiers survives.

const cardContainerVariants = {
  enter: (_direction: number) => ({
    opacity: 0,
  }),
  center: {
    opacity: 1,
    transition: {
      staggerChildren: 0.07,
      delayChildren: 0.02,
    }
  },
  exit: (_direction: number) => ({
    opacity: 0,
    transition: {
      staggerChildren: 0.03,
      staggerDirection: -1 as const,
    }
  })
};

// ─── Quota bar ───────────────────────────────────────────────
// One bar colour for all three buckets. They used to be orchid / violet /
// emerald, which made three neutral facts read as three different *kinds* of
// thing and put a third and fourth hue on a surface that should carry one
// accent. Colour here now means exactly one thing — amber = running low.
function QuotaBar({
  label,
  icon: Icon,
  bucket,
}: {
  label: string;
  icon: React.ElementType;
  bucket: QuotaBucket;
}) {
  const pct = bucket.limit > 0 ? Math.min(100, (bucket.used / bucket.limit) * 100) : 0;
  const isHigh = pct >= 80;
  const pctRemaining = Math.max(0, Math.round(100 - pct));
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon size={12} className="text-text-tertiary" strokeWidth={1.75} />
          <span className="text-[12px] text-text-secondary">{label}</span>
        </div>
        <span
          className={`text-[12px] tabular-nums ${isHigh ? 'text-amber-500 font-medium' : 'text-text-tertiary'}`}
        >
          {pctRemaining}% left
        </span>
      </div>
      <div className="h-[3px] w-full bg-bg-input rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${isHigh ? 'bg-amber-500' : 'bg-accent-primary'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ─── Card wrapper ────────────────────────────────────────────
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={`bg-bg-item-surface rounded-2xl border border-border-subtle overflow-hidden ${className}`}
    >
      {children}
    </div>
  );
}

// ─── Section label ───────────────────────────────────────────
// One small-caps label above each container, replacing the mixture of boxed
// headers, inline titles and uppercase micro-labels this tab used to open
// every section with.
function SectionLabel({ children, aside }: { children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-1 mb-2">
      <p className="text-[11px] font-medium text-text-tertiary uppercase tracking-[0.07em]">
        {children}
      </p>
      {aside}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────
interface NativelyApiSettingsProps {
  initialIsSaved?: boolean;
  afterKeySection?: React.ReactNode;
}

export const NativelyApiSettings: React.FC<NativelyApiSettingsProps> = ({ initialIsSaved = false, afterKeySection: _afterKeySection }) => {
  const prefersReducedMotion = useReducedMotion();
  const t = useT();
  // `initialIsSaved` arrives ASYNCHRONOUSLY. SettingsOverlay seeds its own
  // `hasNativelyKey` to false and only flips it after `getStoredCredentials()`
  // resolves, so on every open of this tab the first render says "no key" even
  // for a subscriber. That is what made the Usage section flash: `usageData`
  // was correctly restored from `usageCache` on the very first render, but the
  // card is gated on `isSaved && usageData`, so it stayed hidden until the
  // credentials round-trip landed and then popped in. The plan chooser
  //
  // A populated `usageCache` is itself proof a key was saved: it is only ever
  // written from a successful quota fetch, and it is nulled on BOTH removal
  // paths (`handleClear`, and the credentials effect when no key comes back).
  // So seeding these three from the cache is sound, and it makes the first
  // paint of a revisit identical to the last paint of the previous visit.
  const cachedKeyKnown = !!usageCache;
  const [apiKey, setApiKey] = useState(() => (initialIsSaved || cachedKeyKnown ? MASKED_NATIVELY_KEY : ''));
  const [isSaved, setIsSaved] = useState(initialIsSaved || cachedKeyKnown);
  const [isLoading, setIsLoading] = useState(!(initialIsSaved || cachedKeyKnown));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const [usageData, setUsageData] = useState<UsageData | null>(() => usageCache);
  const [isLoadingUsage, setIsLoadingUsage] = useState(false);

  // Selection is purely manual now — the tier selector used to auto-rotate
  // through Standard/Pro/Max/Ultra every 4.5s via setInterval, which reads
  // fine as a marketing carousel but fights a "calm once loaded" settings
  // page: content shifting under a user's cursor while they're trying to
  // read is disorienting, and it recreates itself every time this tab is
  // revisited (module state doesn't survive the SettingsOverlay unmount).

  const [interfaceTheme, setInterfaceTheme] = useState<MeetingInterfaceTheme>(() => {
    const theme = getMeetingInterfaceTheme();
    return theme === 'default' ? 'liquid-glass' : theme;
  });



  

  useEffect(() => {
    (async () => {
      try {
        const creds = await window.electronAPI.getStoredCredentials();
        if (creds.hasNativelyKey) {
          setApiKey(MASKED_NATIVELY_KEY);
          setIsSaved(true);
        } else {
          setApiKey('');
          setIsSaved(false);
          setUsageCache(null);
          setUsageData(null);
        }
      } catch (e) {
        console.error('[NativelyApi]', e);
        // Unknown is not saved. `isSaved` now starts optimistically true when a
        // persisted usage entry exists, so without this a keychain read failure
        // would leave a masked key in the field with no way out: `handleSave`
        // refuses any value containing '•', so the Activate button would
        // silently no-op. Falling back to the empty state keeps the input
        // usable.
        setApiKey('');
        setIsSaved(false);
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  // `silent`: revalidate in the background without the loading spinner —
  // used when the tab re-appears and we already have last-known numbers on
  // screen. The manual Refresh button stays non-silent so an explicit click
  // still shows explicit spinner feedback. Either way, a failure (no quota,
  // inactive subscription, network error) just leaves the Usage card hidden
  // — see the `isSaved && usageData` render gate below — rather than
  // surfacing an error card, since a saved-but-not-a-valid-API-plan key is
  // an expected state (e.g. it's actually a Pro-only license), not a fault.
  const fetchUsage = useCallback(async (opts: { force?: boolean; silent?: boolean } = {}) => {
    const { force = false, silent = false } = opts;
    if (!silent) setIsLoadingUsage(true);
    try {
      const r = await window.electronAPI.getNativelyUsage(force);
      if (r.ok && r.quota) {
        setUsageCache(r as UsageData);
        setUsageData(r as UsageData);
      }
    } catch {
      // no-op — see comment above
    } finally {
      if (!silent) setIsLoadingUsage(false);
    }
  }, []);

  useEffect(() => {
    if (!isSaved || isLoading) return;
    // First-ever load in this session (no cache yet) shows the spinner and
    // surfaces errors normally. A re-visit with cached numbers already on
    // screen instead revalidates silently in the background — the whole
    // point being the user never sees a loading state for data they've
    // already seen once this session.
    fetchUsage({ force: true, silent: !!usageCache });
  }, [isSaved, isLoading, fetchUsage]);

  

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed || apiKey.includes('•')) return;
    if (!trimmed.startsWith('natively_sk_')) {
      setError('Invalid Natively API key. Keys must start with natively_sk_.');
      return;
    }
    setIsSaving(true);
    setError(null);
    try {
      const r = await window.electronAPI.setNativelyApiKey(trimmed);
      if (r.success) {
        setApiKey('•'.repeat(24));
        setIsSaved(true);
        setJustSaved(true);
        setTimeout(() => setJustSaved(false), 2500);
        // NOTE: do NOT also call setDefaultModel('natively') / setSttProvider('natively')
        // here. The main-process `set-natively-api-key` handler already auto-promotes
        // both the default model and the STT provider server-side (see
        // CredentialsManager.setNativelyApiKey) and runs reconfigureSttProvider once.
        // Firing those extra IPCs raced a SECOND audio-pipeline rebuild against the
        // first, which deadlocked/crashed the native audio stack right after a key
        // save (the "app hangs after entering the key" bug, macOS + Windows).
      } else {
        setError(r.error || 'Failed to save API key');
      }
    } catch (e: any) {
      setError(e.message || 'Unexpected error');
    } finally {
      setIsSaving(false);
    }
  };



  // The Usage card is the one region that CANNOT be put on a fixed schedule:
  // its data comes from the network, so on activation `isSaved` flips, the plan
  // chooser starts leaving, `fetchUsage` fires, and the quota lands some
  // variable time later. A plain delay would fire before the data exists on a
  // cold fetch and the card would then pop in with no animation at all.
  //
  // So the layout sequence stays driven by `isSaved`, and this card spends
  // whatever is LEFT of its scheduled slot when its data actually arrives:
  //   * warm `usageCache` (persisted across restarts) — elapsed ≈ 0, so it takes
  //     the full 140ms and lands in its choreographed slot, crossing the
  //     chooser's collapse exactly as designed;
  //   * cold fetch at 800ms — the slot is long gone, delay clamps to 0, and it
  //     animates in the instant the numbers land, which reads as "the data just
  //     arrived" because that is what happened;
  //   * fetch fails — nothing appears, per the existing decision at the render
  //     gate below that a saved-but-planless key is an expected state.
  // Same curve and duration in every case, so a slow network degrades to a late
  // animation, never to a cut.
  const usageArmedAtRef = useRef<number | null>(null);
  if (isSaved) { if (usageArmedAtRef.current === null) usageArmedAtRef.current = performance.now(); }
  else usageArmedAtRef.current = null;

  const usageDelay = (slot: number) =>
    usageArmedAtRef.current === null
      ? 0
      : Math.max(0, slot - (performance.now() - usageArmedAtRef.current) / 1000);

  const clearingRef = useRef(false);

  const handleClear = async () => {
    if (clearingRef.current) return;
    clearingRef.current = true;
    const prevKey = apiKey;
    // Optimistic ON PURPOSE, and it needs no spinner: unlike Deactivate — whose
    // only visible effect was a card vanishing after an await, so the wait was
    // dead air — this immediately moves four regions of the page. That layout
    // change IS the feedback, and a spinner would only delay it.
    //
    // What was actually wrong here is that failure was unobservable. This call
    // also revokes the bundled Pro licence (ipcHandlers.ts:6380), and it used to
    // be fired un-awaited into `.catch(() => {})`. If it rejected, the key was
    // still saved in main, Pro was still active, and the user was looking at a
    // UI that had animated a removal which never happened.
    //
    // `usageData` is deliberately NOT cleared here — see the Usage card's
    // AnimatePresence below, which cannot play an exit for a child whose data
    // has already gone.
    setApiKey('');
    setIsSaved(false);
    setError(null);
    setUsageCache(null);
    try {
      await window.electronAPI.setNativelyApiKey('');
    } catch (e: any) {
      // The entrance/exit are declarative on `isSaved`, so the rollback animates
      // back in on the same curves without any extra work.
      setApiKey(prevKey);
      setIsSaved(true);
      setError(e?.message || 'Could not remove the key — it is still saved.');
    } finally {
      clearingRef.current = false;
    }
  };

  const openExternal = (url: string) => {
    (window.electronAPI as any)?.openExternal?.(url);
  };

  const isDirty = apiKey.length > 0 && !apiKey.includes('•') && !isSaved;
  const planLabel = usageData?.plan
    ? usageData.plan.charAt(0).toUpperCase() + usageData.plan.slice(1)
    : null;
  const fmtDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });
    } catch {
      return iso;
    }
  };


  return (
    // LayoutGroup so the three regions below share one layout pass. See
    // ../../lib/plansMotion for why this whole tab is FLIP rather than resizing.
    <LayoutGroup>
    <div className="space-y-6 animated fadeIn" data-interface-theme={interfaceTheme}>
      {/* ── Natively key card — one box for either credential type ────── */}
      <div>
        <SectionLabel
          aside={
            !isLoading && isSaved ? (
              <div className="flex items-center gap-3 shrink-0">
                <span className="flex items-center gap-1.5 text-[11px] font-medium text-emerald-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                  {planLabel ?? 'Connected'}
                </span>
                <button
                  onClick={handleClear}
                  className="flex items-center gap-1 text-[11px] text-text-tertiary hover:text-[var(--text-danger)] transition-colors duration-150 cursor-pointer motion-reduce:transition-none"
                >
                  <Trash2 size={11} strokeWidth={2} />
                  Remove
                </button>
              </div>
            ) : undefined
          }
        >
          Natively key
        </SectionLabel>

        {/* `natively-key-card` gives the flat box the same MATERIAL as the
            rest of this tab — layered fill, specular top hairline, 24px
            blueprint grid, raised floor shadow — without its COLOUR. The
            plaque and its well are achromatic; the Activate button is the only
            saturated thing in the section, and only once it has something to
            act on. See the "tactile credential plaque" block in index.css. */}
        <Card className="natively-key-card">
          <div className="px-4 py-4 space-y-3">
            {/* Says the quiet part out loud: one box, EITHER credential. The
                placeholder alone was carrying that, and a placeholder
                disappears the moment you type.

                The mark sits ON this line rather than in a header of its own:
                no squircle, no tinted well, no title + sub-label block. The
                section label above is still the heading. */}
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="natively-key-mark"
                style={{ ['--natively-key-mark-src' as string]: `url(${nativelyLogo})` } as React.CSSProperties}
              />
              <p className="natively-key-sub text-[12px] leading-snug">
                Connect your Natively API key.
              </p>
            </div>

            {/* The input is the subject of this card. It's now a pressed-in
                well rather than a hairline box — same inset vocabulary as the
                jelly controls, and it gives the credential somewhere to sit.

                The placeholder names the two credential types instead of
                showing the raw `natively_sk_` prefix. That prefix is real —
                handleSave routes on it — but it is an implementation detail
                the user has no reason to recognise, and pairing a literal
                token against the plain-English "or your Pro license key" made
                the two halves read as different KINDS of thing rather than as
                two options for the same box. */}
            <input
              type="text"
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setIsSaved(false);
                setError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
              placeholder="Natively API key"
              spellCheck={false}
              autoComplete="off"
              data-invalid={error ? 'true' : 'false'}
              className="natively-key-input w-full px-3.5 h-11 text-[13px] font-mono text-text-primary
                            placeholder:text-text-tertiary placeholder:font-sans"
            />

            {/* Error */}
            {error && (
              <div className="flex items-center gap-2 text-[12px] text-[var(--text-danger)]">
                <AlertCircle size={13} className="shrink-0" />
                {error}
              </div>
            )}

            {/* Save / Activate button. The disabled state used to be a
                full-width saturated slab (`bg-legacy-action-disabled-bg`),
                which made a control you cannot press the loudest element on
                the card. It now recedes until there's something to submit.
                The four states are unchanged — they're just projected onto a
                `data-state` attribute so the paint (jelly clay on the accent
                accent when ready, ghost when not, tinted chip on success)
                lives in index.css next to the rest of the tab's material. */}
            <button
              onClick={handleSave}
              disabled={isSaving || !isDirty}
              data-state={
                isSaving ? 'saving' : justSaved ? 'done' : !isDirty ? 'idle' : 'ready'
              }
              className={`natively-key-cta w-full h-10 text-[13px] font-medium select-none ${
                isSaving
                  ? 'cursor-wait'
                  : justSaved
                    ? 'cursor-pointer'
                    : !isDirty
                      ? 'cursor-default'
                      : 'cursor-pointer'
              }`}
            >
              {isSaving ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={13} className="animate-spin" />
                  Activating…
                </span>
              ) : justSaved ? (
                <span className="flex items-center justify-center gap-2">
                  <CheckCircle size={13} />
                  Saved
                </span>
              ) : (
                'Save key'
              )}
            </button>
          </div>
        </Card>

        {/* T&C footnote under the card. The "Don't have a key? Subscribe to get
            one" prompt that used to lead this line is gone — the plan chooser
            directly below is the same call to action, stated better. */}
        <p className="text-[11px] text-text-tertiary leading-relaxed mt-2.5 px-1 text-center">
          By activating, you agree to our{' '}
          <span
            onClick={() => openExternal('https://natively.software/nativelyapi/t&c')}
            className="text-text-secondary hover:text-text-primary underline decoration-border-muted underline-offset-[3px] cursor-pointer transition-colors duration-150 motion-reduce:transition-none"
          >
            Terms &amp; Conditions
          </span>
          .
        </p>
      </div>

      {/* ── Usage card — only for a Natively API key with a confirmed  ── */}
      {/* valid plan (usageData populated by a successful quota fetch). */}
      {/* isSaved alone isn't enough: a saved-but-invalid/inactive key   */}
      {/* has nothing usage-shaped to show, so the section stays hidden */}
      {/* entirely rather than surfacing a card with an error in it.    */}
      {/* Presence is gated on `isSaved` ALONE, and `usageData` is cleared from
          this wrapper's onExitComplete rather than in handleClear. AnimatePresence
          cannot play an exit for a child whose data has already vanished — nulling
          both in the same tick made this unmount instantly no matter what it was
          wrapped in. The inner guard keeps the null-safety for the case where a
          saved key simply has no valid plan. */}
      <AnimatePresence mode="popLayout" initial={false} onExitComplete={() => setUsageData(null)}>
      {isSaved && usageData && (
        <motion.div
          key="api-usage"
          layout="position"
          // width:100% is REQUIRED, not cosmetic: mode="popLayout" sets
          // position:absolute on the exiting child, and without an explicit
          // width it collapses to content width the instant it pops — a
          // visible horizontal snap before the fade.
          // `contain: layout` (never `paint` — these cards' 12-32px shadows
          // paint outside their box and would be clipped) confines the
          // invalidation of the two commit-pass layouts.
          style={{ width: '100%', contain: 'layout' }}
          // No `y` and no `height`. FLIP owns every pixel of vertical motion;
          // a `y` on top of it composites a second translation, and a `height`
          // is what made this choppy in the first place.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 0.985 }}
          transition={
            prefersReducedMotion
              ? { duration: INK.in, delay: usageDelay(BEAT) }
              : {
                // `layout` defaults to a SPRING — name it or the house curves
                // are silently discarded.
                layout: { duration: SETTLE.activate, ease: EASE_ENTER },
                opacity: { duration: INK.in, ease: EASE_ENTER, delay: usageDelay(BEAT) },
                default: { duration: INK.out, ease: EASE_LEAVE },
              }
          }
        >
          <SectionLabel
            aside={
              <span className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-text-tertiary">
                  Resets {fmtDate(usageData.quota.resets_at)}
                </span>
                <button
                  onClick={() => fetchUsage({ force: true })}
                  disabled={isLoadingUsage}
                  title="Refresh"
                  aria-label="Refresh usage"
                  className="flex items-center justify-center w-5 h-5 rounded-md text-text-tertiary
                                hover:text-text-secondary transition-colors duration-150 motion-reduce:transition-none
                                disabled:opacity-40 cursor-pointer shrink-0"
                >
                  <RefreshCw
                    size={11}
                    className={isLoadingUsage ? 'animate-spin' : ''}
                    strokeWidth={2}
                  />
                </button>
              </span>
            }
          >
            Usage this month
          </SectionLabel>

          <Card>
            <div className="px-4 py-4 space-y-4">
              <QuotaBar label="Transcription" icon={Mic} bucket={usageData.quota.transcription} />
              <QuotaBar label="AI requests" icon={Brain} bucket={usageData.quota.ai} />
              <QuotaBar label="Web searches" icon={Search} bucket={usageData.quota.search} />
            </div>
          </Card>
        </motion.div>
      )}
      </AnimatePresence>

      {/* ── How it works + Refund Policy — collapsed by default, this is ── */}
      {/* reference material, not something read on every settings visit.  */}
    </div>
    </LayoutGroup>
  );
};
