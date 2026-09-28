import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  onSnapshot,
  doc,
  updateDoc,
  Timestamp,
} from 'firebase/firestore';
import { db } from '../firebase'; // adjust path

export type RequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface AccessRequest {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  status: RequestStatus;
  role: string;
  requestedAt?: Timestamp | null;
}

type Tab = 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL';

const AdminNexus: React.FC = () => {
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [tab, setTab] = useState<Tab>('PENDING');
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const initialLoad = useRef(true);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  // ---- Real-time listener -------------------------------------------------
  useEffect(() => {
    initialLoad.current = true;

    const unsub = onSnapshot(
      collection(db, 'access_requests'),
      (snapshot) => {
        const list: AccessRequest[] = snapshot.docs.map((d) => {
          const data = d.data();
          return {
            uid: d.id,
            displayName: data.displayName ?? '',
            email: data.email ?? '',
            photoURL: data.photoURL ?? '',
            status: (data.status as RequestStatus) ?? 'PENDING',
            role: data.role ?? 'PENDING',
            requestedAt: data.requestedAt ?? null,
          };
        });

        // newest first; docs with a not-yet-resolved server timestamp go on top
        list.sort(
          (a, b) =>
            (b.requestedAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER) -
            (a.requestedAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER)
        );
        setRequests(list);
        setError(null);

        // Toast only for genuinely new requests after the first load
        if (!initialLoad.current) {
          snapshot.docChanges().forEach((change) => {
            if (change.type === 'added' && change.doc.data().status === 'PENDING') {
              const d = change.doc.data();
              setToast(`New access request: ${d.displayName || d.email}`);
              clearTimeout(toastTimer.current);
              toastTimer.current = setTimeout(() => setToast(null), 5000);
            }
          });
        }
        initialLoad.current = false;
      },
      (err) => {
        console.error('[AdminNexus] snapshot error:', err);
        setError(err.code === 'permission-denied'
          ? 'Permission denied. Check firestore.rules and that you are signed in as the super admin.'
          : err.message);
      }
    );

    return () => {
      unsub();
      clearTimeout(toastTimer.current);
    };
  }, []);

  // ---- Filtering ----------------------------------------------------------
  const filtered = useMemo(
    () => (tab === 'ALL' ? requests : requests.filter((r) => r.status === tab)),
    [requests, tab]
  );

  // ---- Handlers -----------------------------------------------------------
  const handleApprove = async (uid: string) => {
    try {
      await updateDoc(doc(db, 'access_requests', uid), {
        status: 'APPROVED',
        role: 'EMPLOYEE',
      });
    } catch (e) {
      console.error('[AdminNexus] approve failed:', e);
      setError('Failed to approve request.');
    }
  };

  const handleReject = async (uid: string) => {
    try {
      await updateDoc(doc(db, 'access_requests', uid), {
        status: 'REJECTED',
        role: 'REJECTED',
      });
    } catch (e) {
      console.error('[AdminNexus] reject failed:', e);
      setError('Failed to reject request.');
    }
  };

  /*
    ------------------------------------------------------------------------
    IMPORTANT: I can't see your existing Admin Nexus markup, so the JSX below
    is a bare stand-in. Keep YOUR existing return(...) block untouched and
    just wire it to: `filtered`, `tab`/`setTab`, `handleApprove(uid)`,
    `handleReject(uid)`, `error`, and `toast`.
    ------------------------------------------------------------------------
  */
  return (
    <div>
      {toast && (
        <div role="status" style={{ position: 'fixed', top: 16, right: 16, zIndex: 9999,
          background: '#111', color: '#fff', padding: '10px 14px', borderRadius: 8 }}>
          {toast}
        </div>
      )}
      {error && <p role="alert">{error}</p>}

      <div>
        {(['PENDING', 'APPROVED', 'REJECTED', 'ALL'] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} disabled={tab === t}>
            {t} ({t === 'ALL' ? requests.length : requests.filter((r) => r.status === t).length})
          </button>
        ))}
      </div>

      <table>
        <tbody>
          {filtered.map((r) => (
            <tr key={r.uid}>
              <td>{r.displayName}</td>
              <td>{r.email}</td>
              <td>{r.status}</td>
              <td>
                {r.status !== 'APPROVED' && <button onClick={() => handleApprove(r.uid)}>Approve</button>}
                {r.status !== 'REJECTED' && <button onClick={() => handleReject(r.uid)}>Reject</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default AdminNexus;
