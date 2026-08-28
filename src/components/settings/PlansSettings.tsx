import React from 'react';
import { NativelyApiSettings } from './NativelyApiSettings';

export interface PlansSettingsProps {
  initialIsPremium?: boolean | null;
  initialHasNativelyKey?: boolean;
}

/**
 * Compatibility route for the old "Plans & Billing" tab.
 *
 * The paid-plan, license-purchase, subscription, trial, and refund UI has been
 * removed. The route is retained only so an older settings navigation entry
 * cannot produce a blank page; it now contains the Natively API key settings.
 */
export const PlansSettings: React.FC<PlansSettingsProps> = ({
  initialHasNativelyKey = false,
}) => (
  <div className="space-y-6 animated fadeIn">
    <header>
      <h2 className="text-[17px] font-semibold text-text-primary tracking-[-0.015em]">Natively API</h2>
      <p className="text-[12px] text-text-secondary leading-relaxed mt-1.5">
        Connect your Natively API key to use Natively services.
      </p>
    </header>
    <NativelyApiSettings initialIsSaved={initialHasNativelyKey} />
  </div>
);

export default PlansSettings;
