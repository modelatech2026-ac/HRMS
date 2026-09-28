/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from "react";
import { ShieldCheck, Lock, X, AlertCircle, ArrowRight, KeyRound } from "lucide-react";

interface AdminAccessVerificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onVerified: () => void;
}

// Master Admin Security PINs / Keys allowed for privileged role switch
const VALID_ADMIN_KEYS = [
  "9948", // Default enterprise HR Admin PIN
  "ADMIN2026", // Admin master authorization key
  "MODELA#HR", // Secret clearance token
  "1234", // Quick testing PIN
];

export const AdminAccessVerificationModal: React.FC<AdminAccessVerificationModalProps> = ({
  isOpen,
  onClose,
  onVerified,
}) => {
  const [accessKey, setAccessKey] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [isVerifying, setIsVerifying] = useState<boolean>(false);

  if (!isOpen) return null;

  const handleVerify = (e: React.FormEvent) => {
    e.preventDefault();
    const clean = accessKey.trim();

    if (!clean) {
      setError("Please enter the Admin Security PIN or Master Key.");
      return;
    }

    setIsVerifying(true);
    setError("");

    setTimeout(() => {
      setIsVerifying(false);
      if (VALID_ADMIN_KEYS.includes(clean.toUpperCase()) || VALID_ADMIN_KEYS.includes(clean)) {
        setAccessKey("");
        setError("");
        onVerified();
      } else {
        setError("Invalid Admin Access PIN or Clearance Key. Access denied.");
      }
    }, 350);
  };

  const handleClose = () => {
    setAccessKey("");
    setError("");
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-verify-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-xs animate-in fade-in duration-200"
    >
      <div className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl p-6 text-slate-100 relative">
        <button
          onClick={handleClose}
          className="absolute top-4 right-4 p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          aria-label="Close"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400 flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 id="admin-verify-title" className="text-base font-bold text-white tracking-tight">
              HR Admin Clearance
            </h3>
            <p className="text-xs text-slate-400">Restricted privileged role switch</p>
          </div>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed mb-4">
          Enter the authorized Admin Access PIN or Master Clearance Key to unlock the Admin Portal.
        </p>

        <form onSubmit={handleVerify} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Admin PIN / Security Key
            </label>
            <div className="relative">
              <input
                type="password"
                value={accessKey}
                onChange={(e) => {
                  setAccessKey(e.target.value);
                  if (error) setError("");
                }}
                autoFocus
                placeholder="Enter PIN (e.g. 9948)"
                className="w-full pl-3.5 pr-9 py-2.5 bg-slate-800 border border-slate-700 focus:border-blue-500 rounded-xl text-sm font-mono text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <KeyRound className="w-4 h-4 text-slate-500 absolute right-3 top-3 pointer-events-none" />
            </div>
            <p className="text-[10px] text-slate-500">
              Default authorized PIN: <code className="text-blue-400 font-mono font-bold">9948</code>
            </p>
          </div>

          {error && (
            <div className="p-2.5 bg-rose-950/40 border border-rose-900/80 rounded-xl flex items-start gap-2 text-xs text-rose-300 animate-in fade-in duration-150">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
              <span>{error}</span>
            </div>
          )}

          <div className="flex items-center gap-2 pt-2">
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 py-2.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isVerifying || !accessKey.trim()}
              className="flex-1 py-2.5 px-3 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5 cursor-pointer shadow-sm shadow-blue-950/40"
            >
              {isVerifying ? (
                <span>Checking...</span>
              ) : (
                <>
                  <span>Verify</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
