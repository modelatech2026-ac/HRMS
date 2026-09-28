import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { onAuthStateChanged, signOut as fbSignOut, User } from 'firebase/auth';
import { doc, getDoc, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from '../firebase'; // adjust path to your existing firebase init

const SUPER_ADMIN_EMAIL = 'modelatech2026@gmail.com';
const FIRESTORE_TIMEOUT_MS = 3000;

export type AppRole = 'SUPER_ADMIN' | 'EMPLOYEE' | 'PENDING' | 'REJECTED';
export type AccessStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

interface AuthContextValue {
  user: User | null;
  role: AppRole | null;
  status: AccessStatus | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  role: null,
  status: null,
  loading: true,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

const withTimeout = <T,>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Firestore timeout')), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const unsub = onAuthStateChanged(auth, async (fbUser) => {
      setLoading(true);
      setUser(fbUser);

      if (!fbUser) {
        setRole(null);
        setStatus(null);
        setLoading(false);
        return;
      }

      // 1. Super admin: granted immediately, no Firestore dependency.
      if (fbUser.email?.toLowerCase() === SUPER_ADMIN_EMAIL) {
        setRole('SUPER_ADMIN');
        setStatus('APPROVED');
        setLoading(false);
        return;
      }

      // 2. Everyone else: ensure an access request exists in Firestore.
      try {
        await withTimeout(
          (async () => {
            const ref = doc(db, 'access_requests', fbUser.uid);
            const snap = await getDoc(ref);

            if (snap.exists()) {
              // Already requested: honour the admin's decision, never reset it.
              const data = snap.data();
              if (!cancelled) {
                setRole((data.role as AppRole) ?? 'PENDING');
                setStatus((data.status as AccessStatus) ?? 'PENDING');
              }
              return;
            }

            await setDoc(
              ref,
              {
                uid: fbUser.uid,
                displayName: fbUser.displayName ?? '',
                email: fbUser.email ?? '',
                photoURL: fbUser.photoURL ?? '',
                status: 'PENDING',
                role: 'PENDING',
                requestedAt: serverTimestamp(),
              },
              { merge: true }
            );
            if (!cancelled) {
              setRole('PENDING');
              setStatus('PENDING');
            }
          })(),
          FIRESTORE_TIMEOUT_MS
        );
      } catch (err) {
        console.error('[AuthContext] access request sync failed:', err);
        if (!cancelled) {
          setRole((r) => r ?? 'PENDING');
          setStatus((s) => s ?? 'PENDING');
        }
      } finally {
        if (!cancelled) setLoading(false); // always release the loading screen
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const signOut = useCallback(async () => {
    await fbSignOut(auth);
  }, []);

  return (
    <AuthContext.Provider value={{ user, role, status, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
