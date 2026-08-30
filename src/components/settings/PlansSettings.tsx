import React from 'react';

export interface PlansSettingsProps {
  initialIsPremium?: boolean | null;
  initialHasNativelyKey?: boolean;
}

/**
 * The hosted Natively backend has been removed from this build.
 * The tab remains only as a placeholder for the legacy settings route, and the
 * app now routes users through the active multi-provider configuration instead.
 */
export const PlansSettings: React.FC<PlansSettingsProps> = () => (
  <div className="space-y-6 animated fadeIn">
    <header>
      <h2 className="text-[17px] font-semibold text-text-primary tracking-[-0.015em]">Plans &amp; Billing</h2>
      <p className="text-[12px] text-text-secondary leading-relaxed mt-1.5">
        This build no longer uses the hosted Natively API backend. Configure your supported providers in AI Providers instead.
      </p>
    </header>
  </div>
);

export default PlansSettings;
